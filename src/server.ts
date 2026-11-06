/**
 * Tool definitions and handlers for the Cloudflare Workers MCP server.
 *
 * `buildServer()` is pure: no I/O at import time and none while building, so
 * the stdio entry (`index.ts`) can call it once per connection and tests can
 * drive it over an in-memory transport with a mocked fetch.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  ToolCallback,
  CallToolResult,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { CloudflareAPIError, WorkersClient } from "./workers/client.js";
import { collectAssets, uploadAssets } from "./workers/assets.js";
import { collectTail } from "./workers/tail.js";
import {
  summarizeDeployment,
  summarizeDomain,
  summarizeLogEvent,
  summarizeTailEvent,
  summarizeVersion,
  summarizeWorker,
} from "./workers/summarize.js";
import type {
  AssetsConfig,
  VersionBody,
  VersionModule,
  WorkerInfo,
  WorkerModule,
  WorkerPatch,
  WorkerPreview,
  WorkerVersion,
} from "./workers/types.js";
import { formatError, formatSuccess } from "./utils/errors.js";

// Read the package version at runtime (src/ or the dist/index.js bundle -> ../package.json). npm
// always ships package.json, so this resolves both in dev and when installed.
export const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

// ==================== Tool Input Schemas ====================
//
// Each tool's input contract is a single Zod schema. The schema is handed to
// `registerTool` as-is (the SDK generates the advertised JSON Schema and
// validates inputs before the handler runs), and `z.infer` types the handler
// arguments. There is intentionally no second, hand-written JSON Schema copy.

const GetWorkerSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const GetWorkerCodeSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const ListVersionsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const ListDeploymentsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const GetVersionSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  version_id: z.string().describe("Version ID (from list_versions)"),
});

const GetCronTriggersSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const ListWorkerDomainsSchema = z.object({
  service: z.string().optional().describe("Filter by Worker (service) name"),
  hostname: z.string().optional().describe("Filter by hostname"),
  zone_name: z.string().optional().describe("Filter by zone name"),
  zone_id: z.string().optional().describe("Filter by zone ID"),
  environment: z.string().optional().describe("Filter by environment"),
});

const HtmlHandlingSchema = z
  .enum(["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"])
  .optional()
  .describe("How HTML URLs are canonicalized (default: auto-trailing-slash)");

const NotFoundHandlingSchema = z
  .enum(["none", "404-page", "single-page-application"])
  .optional()
  .describe(
    "Response when no asset matches: 'single-page-application' serves /index.html (SPA mode), '404-page' serves /404.html (default: none)"
  );

const BasePathSchema = z
  .string()
  .regex(/^\//, "base_path must start with '/'")
  .optional()
  .describe(
    "Serve the assets under this URL prefix, e.g. '/blog' (default '/'). Paths in _headers and _redirects must include the prefix; requests outside it don't resolve assets. Cloudflare is rolling this out per account — a non-root value may fail with error 100343 until enabled."
  );

const DeployStaticSiteSchema = z.object({
  script_name: z
    .string()
    .describe("Worker name to deploy the site as (lowercase, alphanumeric and hyphens)"),
  directory: z
    .string()
    .describe("Path to the built site directory to upload (absolute path recommended)"),
  html_handling: HtmlHandlingSchema,
  not_found_handling: NotFoundHandlingSchema,
  base_path: BasePathSchema,
  compatibility_date: z
    .string()
    .optional()
    .describe("Worker compatibility date (YYYY-MM-DD); defaults to today"),
  enable_workers_dev: z
    .boolean()
    .optional()
    .describe(
      "Serve the site at <script_name>.<account>.workers.dev. Default: enabled for newly created Workers; existing Workers keep their current setting."
    ),
});

// No asset-config inputs: with keep_assets the API silently ignores
// assets.config (verified live 2026-11-05) and keeps the previous version's
// config. Config changes go through deploy_static_site, which dedupes and
// uploads nothing when files are unchanged. .strict() makes stale callers that
// still pass html_handling/not_found_handling fail loudly instead of no-op.
const RedeployAssetsSchema = z
  .object({
    script_name: z.string().describe("The name of the Worker script"),
    compatibility_date: z
      .string()
      .optional()
      .describe("Worker compatibility date (YYYY-MM-DD); defaults to the Worker's current date"),
  })
  .strict();

// The v1 binding subset (IMPLEMENTATION_PLAN.md M3). Values pass through to
// metadata.bindings verbatim; the discriminated union keeps each type's
// required fields honest.
const BindingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plain_text"),
    name: z.string().describe("Variable name exposed to the Worker"),
    text: z.string().describe("The value"),
  }),
  z.object({
    type: z.literal("secret_text"),
    name: z.string().describe("Variable name exposed to the Worker"),
    text: z.string().describe("The secret value (never returned by reads)"),
  }),
  z.object({
    type: z.literal("kv_namespace"),
    name: z.string().describe("Variable name exposed to the Worker"),
    namespace_id: z.string().describe("KV namespace ID"),
  }),
  z.object({
    type: z.literal("r2_bucket"),
    name: z.string().describe("Variable name exposed to the Worker"),
    bucket_name: z.string().describe("R2 bucket name"),
  }),
  z.object({
    type: z.literal("d1"),
    name: z.string().describe("Variable name exposed to the Worker"),
    id: z.string().describe("D1 database ID"),
  }),
  z.object({
    type: z.literal("assets"),
    name: z.string().describe("Variable name for the Worker's own static assets (e.g. ASSETS)"),
  }),
]);

const ModuleSchema = z.object({
  name: z.string().describe("Module filename, e.g. index.js"),
  content: z.string().describe("Module source code"),
  content_type: z
    .string()
    .optional()
    .describe("Part content type (default application/javascript+module)"),
});

const DeployWorkerSchema = z.object({
  script_name: z
    .string()
    .describe("Worker name (lowercase, alphanumeric and hyphens)"),
  modules: z.array(ModuleSchema).min(1).describe("ES modules; the first is the entry point unless main_module says otherwise"),
  main_module: z.string().optional().describe("Entry-point module name (default: first module)"),
  bindings: z.array(BindingSchema).optional().describe("Resource bindings (replaces the full set)"),
  compatibility_date: z
    .string()
    .optional()
    .describe("YYYY-MM-DD; defaults to today (if omitted at the API level it would fall back to 2021-11-02)"),
  compatibility_flags: z
    .array(z.string())
    .optional()
    .describe(
      "Runtime compatibility flags. nodejs_compat is on by default for compatibility_date >= 2026-08-04, so it is not needed with the default (today) date"
    ),
  keep_assets: z
    .boolean()
    .optional()
    .describe("Retain the previous version's static assets (deploy code changes to a site without re-uploading files)"),
  enable_observability: z
    .boolean()
    .optional()
    .describe("Enable Workers Logs for this Worker (required for query_worker_logs)"),
  enable_workers_dev: z
    .boolean()
    .optional()
    .describe(
      "Serve the Worker at <script_name>.<account>.workers.dev. Default: enabled for newly created Workers; existing Workers keep their current setting."
    ),
});

const CreateVersionSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  modules: z
    .array(ModuleSchema)
    .min(1)
    .describe("ES modules; the first is the entry point unless main_module says otherwise"),
  main_module: z.string().optional().describe("Entry-point module name (default: first module)"),
  bindings: z.array(BindingSchema).optional().describe("Resource bindings for this version"),
  compatibility_date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
  compatibility_flags: z
    .array(z.string())
    .optional()
    .describe(
      "Runtime compatibility flags. nodejs_compat is on by default for compatibility_date >= 2026-08-04, so it is not needed with the default (today) date"
    ),
  keep_assets: z
    .boolean()
    .optional()
    .describe("Retain the previous version's static assets"),
  message: z
    .string()
    .optional()
    .describe("Version message (workers/message annotation, shown in the dashboard)"),
  tag: z.string().optional().describe("Version tag (workers/tag annotation)"),
});

const DeploymentVersionSchema = z.object({
  version_id: z.string().describe("Version ID (from list_versions or create_version)"),
  percentage: z.number().gt(0).max(100).describe("Share of traffic for this version"),
});

const CreateDeploymentSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  versions: z
    .array(DeploymentVersionSchema)
    .min(1)
    .max(2)
    .describe(
      "One version at 100%, or two versions splitting traffic (e.g. 90/10 for a gradual rollout). Percentages must sum to 100."
    ),
  message: z.string().optional().describe("Deployment message (workers/message annotation)"),
  force: z
    .boolean()
    .optional()
    .describe("Deploy even if normally blocked (e.g. a secret changed since the target version)"),
});

const RollbackWorkerSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  version_id: z
    .string()
    .describe("The older version to roll back to (must be among the 100 most recent versions)"),
  message: z.string().optional().describe("Rollback message (workers/message annotation)"),
  force: z
    .boolean()
    .optional()
    .describe("Roll back even if normally blocked (e.g. a secret changed since that version)"),
});

const DeleteWorkerSchema = z.object({
  script_name: z.string().describe("The name of the Worker script to delete"),
  force: z
    .boolean()
    .optional()
    .describe("Delete even if other resources (e.g. routes) depend on the Worker"),
});

const UpdateWorkerSettingsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  bindings: z
    .array(BindingSchema)
    .optional()
    .describe("Resource bindings — REPLACES the Worker's full binding set"),
  compatibility_date: z.string().optional().describe("YYYY-MM-DD"),
  compatibility_flags: z
    .array(z.string())
    .optional()
    .describe(
      "Runtime compatibility flags. nodejs_compat is on by default for compatibility_date >= 2026-08-04, so it is not needed with the default (today) date"
    ),
  logpush: z.boolean().optional(),
  observability: z
    .object({
      enabled: z.boolean(),
      head_sampling_rate: z.number().min(0).max(1).optional(),
    })
    .optional()
    .describe("Workers Logs configuration"),
});

const AddWorkerDomainSchema = z.object({
  hostname: z
    .string()
    .describe("Hostname to attach, e.g. app.example.com (zone apex or subdomain)"),
  service: z.string().describe("The Worker (script name) to route the hostname to"),
  environment: z.string().optional().describe("Worker environment (default: production)"),
  zone_id: z.string().optional().describe("Zone ID (the zone must be active in this account)"),
  zone_name: z.string().optional().describe("Zone name, e.g. example.com"),
});

const DeleteWorkerDomainSchema = z.object({
  domain_id: z.string().describe("Domain attachment ID (from list_worker_domains)"),
});

const SetWorkersDevSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  enabled: z.boolean().describe("Serve the Worker at <script_name>.<account>.workers.dev"),
  previews_enabled: z
    .boolean()
    .optional()
    .describe("Also serve preview URLs for uploaded versions"),
});

const SetCronTriggersSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  crons: z
    .array(z.string().describe("Cron expression, e.g. */30 * * * *"))
    .describe("REPLACES the Worker's full cron trigger set; pass [] to remove all triggers"),
});

const DeployPreviewSchema = z
  .object({
    script_name: z.string().describe("The existing Worker to preview (deploy production first)"),
    preview_name: z
      .string()
      .min(1)
      .describe(
        "Preview name, e.g. a branch name. An existing preview with this name is reused, so its stable URL stays the same across deploys."
      ),
    directory: z
      .string()
      .optional()
      .describe("Static site: path to the built site directory (same handling as deploy_static_site)"),
    html_handling: HtmlHandlingSchema,
    not_found_handling: NotFoundHandlingSchema,
    modules: z
      .array(ModuleSchema)
      .min(1)
      .optional()
      .describe("Worker code: ES modules; the first is the entry point unless main_module says otherwise"),
    main_module: z.string().optional().describe("Entry-point module name (default: first module)"),
    bindings: z.array(BindingSchema).optional().describe("Bindings for the preview (modules mode)"),
    compatibility_date: z
      .string()
      .optional()
      .describe("YYYY-MM-DD; defaults to the Worker's current compatibility date"),
    compatibility_flags: z.array(z.string()).optional().describe("Runtime compatibility flags"),
    enable_preview_urls: z
      .boolean()
      .optional()
      .describe(
        "Turn on the Worker's preview URLs (subdomain previews_enabled) if they are off. Without it previews deploy but aren't routable. Default true. Production workers.dev serving is never changed."
      ),
  })
  .refine((input) => (input.directory === undefined) !== (input.modules === undefined), {
    message: "Provide exactly one of directory (static site) or modules (Worker code)",
  });

const ListPreviewsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const DeletePreviewSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  preview: z.string().min(1).describe("Preview name, slug or id (from list_previews)"),
});

const ListSecretsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
});

const SetSecretsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  secrets: z
    .record(z.string().min(1), z.string().nullable())
    .refine((map) => Object.keys(map).length > 0, "Provide at least one secret")
    .describe(
      "Map of secret name -> value. A string creates or updates a secret_text binding, null deletes it, and names not listed are left unchanged. All changes land in ONE new version that is deployed immediately."
    ),
});

const DeleteSecretSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  name: z.string().min(1).describe("Name of the secret binding to delete"),
});

const TailWorkerSchema = z.object({
  script_name: z.string().describe("The Worker to tail"),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(15)
    .describe("How long to listen, in seconds (default 15, max 50 to stay inside client request timeouts)"),
  max_events: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Stop early after this many matching events (default 50)"),
  errors_only: z
    .boolean()
    .optional()
    .describe("Only keep events whose outcome is not ok or that threw an exception"),
  search: z
    .string()
    .optional()
    .describe("Case-insensitive substring matched against log lines, exceptions and request URLs"),
  trigger_url: z
    .string()
    .url()
    .regex(/^https:\/\//, "trigger_url must be an https URL")
    .optional()
    .describe(
      "Optional https URL to GET once the tail is connected (e.g. the Worker route you are debugging) so the request is captured in this same call"
    ),
});

const QueryWorkerLogsSchema = z.object({
  script_name: z.string().describe("The Worker whose logs to query"),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(10080)
    .optional()
    .default(60)
    .describe("Look-back window in minutes (default 60; retention is 3–7 days)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum events to return (default 20)"),
  errors_only: z.boolean().optional().describe("Only return events that carry an error"),
  search: z.string().optional().describe("Full-text needle matched across all log fields"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor: pass the next_cursor from a previous call (with the same filters) to fetch the next page of older events"
    ),
});

/** Today as YYYY-MM-DD — the compatibility_date fallback for brand-new Workers. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ==================== Result Helpers ====================
//
// Results carry both a human-readable text block and the same payload as
// `structuredContent` (recommended since the 2025-06-18 MCP spec revision) so
// structured-content-aware clients don't have to re-parse the JSON text.

function ok(data: unknown, message?: string): CallToolResult {
  const payload = formatSuccess(data, message);
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  const payload = formatError(error);
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true,
  };
}

// ==================== Server ====================

/**
 * Build one McpServer with every tool registered. serveStdio() calls this
 * factory once per connection; the WorkersClient (and its rate limiter) is
 * shared, so it is constructed once in main() and passed in.
 */
export function buildServer(workers: WorkersClient): McpServer {
  // The tools capability is auto-registered by registerTool.
  const server = new McpServer({ name: "cloudflare-workers", version: SERVER_VERSION });

  /**
   * Register a tool from a single Zod schema. The schema becomes the
   * advertised input schema (auto-validated by the SDK before the handler
   * runs) and `z.infer` types the handler args. Thrown errors are formatted
   * into a consistent MCP error result.
   */
  function addTool<S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: S;
      annotations?: ToolAnnotations;
    },
    handler: (args: z.infer<S>, ctx: ServerContext) => Promise<CallToolResult>
  ): void {
    // ToolCallback<S> is a conditional type that TypeScript cannot reduce for
    // an unresolved generic S, so the wrapper needs one cast to the SDK's own
    // callback type; args is the schema's already-validated output.
    const wrapped = (async (args: z.infer<S>, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        return await handler(args, ctx);
      } catch (error) {
        return fail(error);
      }
    }) as ToolCallback<S>;
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.annotations,
      },
      wrapped
    );
  }

  /**
   * Register a tool that takes no input. Registered WITHOUT an inputSchema so
   * the SDK advertises the empty object schema and skips argument validation —
   * a spec-legal call that omits `arguments` entirely must not be rejected.
   */
  function addNoArgTool(
    name: string,
    config: { title: string; description: string; annotations?: ToolAnnotations },
    handler: () => Promise<CallToolResult>
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        annotations: config.annotations,
      },
      (async (): Promise<CallToolResult> => {
        try {
          return await handler();
        } catch (error) {
          return fail(error);
        }
      }) as ToolCallback<undefined>
    );
  }

  // ========== Worker Tools ==========

  addNoArgTool(
    "list_workers",
    {
      title: "List Workers",
      description:
        "List all Workers in your account: name, created/modified/last-deployed timestamps, and whether workers.dev serving and observability are on.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const list = (await workers.listWorkers()).map(summarizeWorker);
      return ok(
        {
          workers: list,
          account_id: workers.getAccountId(),
        },
        `Found ${list.length} Worker(s)`
      );
    }
  );

  addTool(
    "get_worker",
    {
      title: "Get Worker",
      description:
        "Get a Worker's settings (bindings, compatibility date and flags, placement, observability, logpush) for its live version, plus its cron triggers and workers.dev subdomain status.",
      inputSchema: GetWorkerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const existing = await getExisting(input.script_name);
      if (!existing) throw notFound(input.script_name);

      // Cron triggers are folded in best-effort: a failure there (e.g. a token
      // scoped to scripts only) degrades to undefined instead of failing.
      let cron: string[] | undefined;
      try {
        cron = ((await workers.getCronTriggers(input.script_name)).result?.schedules ?? []).map(
          (s) => s.cron
        );
      } catch {
        cron = undefined;
      }

      const sub = existing.worker.subdomain;
      return ok({
        script_name: input.script_name,
        settings: settingsView(existing),
        cron_triggers: cron,
        workers_dev: sub
          ? {
              enabled: sub.enabled,
              previews_enabled: sub.previews_enabled,
              ...(sub.enabled && sub.url && { url: sub.url }),
            }
          : undefined,
      });
    }
  );

  addTool(
    "get_worker_code",
    {
      title: "Get Worker Code",
      description:
        "Download the source code of a Worker's live version: one entry per module. Service-worker-syntax Workers return a single script; assets-only Workers have no code.",
      inputSchema: GetWorkerCodeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const existing = await getExisting(input.script_name);
      if (!existing) throw notFound(input.script_name);
      if (!existing.liveVersionId) {
        throw new Error(`${input.script_name} has no deployed version, so there is no live code to download.`);
      }

      const version = (await workers.getVersion(input.script_name, existing.liveVersionId, true)).result;
      let modules: WorkerModule[] = (version.modules ?? []).map((m) => ({
        name: m.name,
        content_type: m.content_type,
        content: Buffer.from(m.content_base64, "base64").toString("utf8"),
      }));
      let note: string | undefined;

      if (modules.length === 0) {
        // Service-worker-syntax versions carry no modules on the Workers API;
        // the legacy content endpoint still serves them.
        try {
          modules = (await workers.downloadLegacyScript(input.script_name)).modules.filter(
            (m) => m.content.length > 0
          );
          if (modules.length > 0) note = "Service-worker-syntax Worker (single script).";
        } catch {
          modules = [];
        }
        if (modules.length === 0) {
          note = version.assets ? "Assets-only Worker: it serves static files and has no code." : "No code found for the live version.";
        }
      }

      return ok(
        {
          script_name: input.script_name,
          version_id: existing.liveVersionId,
          modules: modules.map((m) => ({
            name: m.name,
            content_type: m.content_type,
            size: Buffer.byteLength(m.content, "utf8"),
            content: m.content,
          })),
          note,
        },
        `Fetched ${modules.length} module(s)`
      );
    }
  );


  // ========== Shared deploy helpers (Workers API) ==========

  interface ExistingWorker {
    worker: WorkerInfo;
    /** The version serving traffic (the larger share during a gradual rollout). */
    liveVersionId?: string;
    /** True when traffic is split across two versions. */
    gradual: boolean;
    liveVersion?: WorkerVersion;
  }

  function notFound(scriptName: string): CloudflareAPIError {
    return new CloudflareAPIError(
      [{ code: 10007, message: `Worker '${scriptName}' not found on this account.` }],
      404
    );
  }

  /**
   * The Worker and its live version, or null when the Worker doesn't exist.
   * Only a definitive 404 means "new": any other failure aborts, so an
   * existing Worker is never mistaken for a new one (which would re-enable
   * workers.dev and reset its compatibility date).
   */
  async function getExisting(scriptName: string): Promise<ExistingWorker | null> {
    let worker: WorkerInfo;
    try {
      worker = (await workers.getWorker(scriptName)).result;
    } catch (error) {
      if (error instanceof CloudflareAPIError && error.statusCode === 404) return null;
      throw error;
    }

    let current: Array<{ version_id: string; percentage: number }> = [];
    try {
      current = (await workers.listDeployments(scriptName)).result?.deployments?.[0]?.versions ?? [];
    } catch (error) {
      // A created-but-never-deployed Worker has no deployments.
      if (!(error instanceof CloudflareAPIError && error.statusCode === 404)) throw error;
    }
    const live = [...current].sort((a, b) => b.percentage - a.percentage)[0];
    const liveVersion = live
      ? (await workers.getVersion(scriptName, live.version_id)).result
      : undefined;
    return { worker, liveVersionId: live?.version_id, gradual: current.length > 1, liveVersion };
  }

  /**
   * Merge-patching `latest` inherits from the most recently CREATED version,
   * which is only safe when that version is the one serving all traffic. A
   * staged version (create_version) or a gradual rollout would otherwise
   * silently become the base of what gets deployed.
   */
  async function assertLatestIsLive(
    scriptName: string,
    existing: ExistingWorker,
    action: string
  ): Promise<void> {
    if (!existing.liveVersionId) {
      throw new Error(`${scriptName} has no deployed version to ${action} from. Deploy it first.`);
    }
    if (existing.gradual) {
      throw new Error(
        `${scriptName} is in a gradual rollout (traffic split across two versions). Finish or roll back the rollout with create_deployment before you ${action}.`
      );
    }
    const latest = (await workers.getLatestVersion(scriptName)).result;
    if (latest?.id !== existing.liveVersionId) {
      throw new Error(
        `The newest version of ${scriptName} (${latest?.id}) is staged, not live (live: ${existing.liveVersionId}), so it can't be used as the base to ${action}. Deploy or discard the staged version with create_deployment first, or do a full upload (deploy_static_site, or deploy_worker without keep_assets).`
      );
    }
  }

  /**
   * Carry the live version's secrets into a new version unless the caller set
   * them explicitly. Legacy script uploads kept secrets implicitly; Workers API
   * versions drop every binding that isn't listed (verified live 2026-11-05).
   */
  function withInheritedSecrets(
    explicit: Array<{ name: string }>,
    existing: ExistingWorker | null
  ): { bindings: Array<Record<string, unknown>>; inherited: string[] } {
    const named = new Set(explicit.map((b) => b.name));
    const inherited = (existing?.liveVersion?.bindings ?? [])
      .filter(
        (b) =>
          (b.type === "secret_text" || b.type === "secret_key") &&
          typeof b.name === "string" &&
          !named.has(b.name)
      )
      .map((b) => b.name as string);
    return {
      bindings: [
        ...(explicit as Array<Record<string, unknown>>),
        ...inherited.map((name) => ({ type: "inherit", name, version_id: existing!.liveVersionId! })),
      ],
      inherited,
    };
  }

  function toVersionModules(
    modules: Array<{ name: string; content: string; content_type?: string }>
  ): VersionModule[] {
    return modules.map((mod) => ({
      name: mod.name,
      content_type: mod.content_type ?? "application/javascript+module",
      content_base64: Buffer.from(mod.content, "utf8").toString("base64"),
    }));
  }

  /**
   * Annotations for versions created by merge-patching `latest`: set an
   * explicit message and clear any inherited tag, so the new version doesn't
   * masquerade as the previous one in list_versions.
   */
  function patchAnnotations(message: string, tag?: string): VersionBody["annotations"] {
    return { "workers/message": message, "workers/tag": tag ?? null };
  }

  /** A new Worker is created with workers.dev on unless explicitly disabled. */
  async function createWorkerFor(
    scriptName: string,
    requestedWorkersDev: boolean | undefined,
    extra: WorkerPatch = {}
  ): Promise<WorkerInfo> {
    return (
      await workers.createWorker(scriptName, {
        subdomain: { enabled: requestedWorkersDev !== false },
        ...extra,
      })
    ).result;
  }

  /**
   * workers.dev after a deploy: an explicit true enables it on an existing
   * Worker; otherwise an existing Worker's setting is left alone and only
   * reported. Returns the URL when served, or a note explaining why not.
   */
  async function workersDevAfterDeploy(
    scriptName: string,
    worker: WorkerInfo,
    requested: boolean | undefined,
    isNew: boolean
  ): Promise<{ url?: string; note?: string }> {
    if (requested === false) return {};
    let sub = worker.subdomain;
    if (!isNew && requested === true && !sub?.enabled) {
      try {
        sub = (
          await workers.patchWorker(scriptName, {
            subdomain: { enabled: true, previews_enabled: sub?.previews_enabled ?? false },
          })
        ).result?.subdomain;
      } catch (error) {
        return {
          note: `Deployed, but enabling workers.dev failed: ${error instanceof Error ? error.message : String(error)}. Enable it with set_workers_dev or attach a custom domain.`,
        };
      }
    }
    if (sub?.enabled) {
      return sub.url
        ? { url: sub.url }
        : { note: "workers.dev is enabled, but the account has no workers.dev subdomain registered yet." };
    }
    return { note: "workers.dev serving is disabled for this Worker (unchanged by this deploy)." };
  }

  /**
   * Worker-level PATCH run after a version is already deployed. A failure here
   * must not read as "nothing happened", so the error names the live version.
   */
  async function patchWorkerAfterDeploy(name: string, patch: WorkerPatch, versionId: string | undefined) {
    try {
      return (await workers.patchWorker(name, patch)).result;
    } catch (error) {
      const what = Object.keys(patch).join("/");
      throw new Error(
        `Version ${versionId ?? "(unknown)"} of ${name} is deployed, but updating ${what} failed: ${error instanceof Error ? error.message : String(error)}. Retry with update_worker_settings.`,
        { cause: error }
      );
    }
  }

  /** Settings view of a Worker: Worker-level fields plus its live version's. */
  function settingsView(existing: ExistingWorker) {
    const version = existing.liveVersion;
    return {
      live_version_id: existing.liveVersionId,
      ...(existing.gradual && { gradual_rollout: true }),
      main_module: version?.main_module,
      bindings: version?.bindings,
      compatibility_date: version?.compatibility_date,
      compatibility_flags: version?.compatibility_flags,
      assets_config: version?.assets?.config,
      placement: version?.placement,
      limits: version?.limits,
      usage_model: version?.usage_model,
      logpush: existing.worker.logpush,
      observability: existing.worker.observability,
      tail_consumers: existing.worker.tail_consumers,
      tags: existing.worker.tags,
    };
  }

  // ========== Static Site Tools ==========

  addTool(
    "deploy_static_site",
    {
      title: "Deploy Static Site",
      description:
        "Deploy a local directory as a static site on Workers (assets-only Worker): builds the file manifest, uploads only files Cloudflare doesn't already have, and deploys. Newly created sites are served on workers.dev. Set not_found_handling to 'single-page-application' for SPAs, and base_path to serve the site under a URL prefix (e.g. '/docs'). _headers/_redirects at the directory root are applied as configuration (not uploaded), and .assetsignore rules (gitignore-style) exclude files from the deploy. Deploying over a Worker that has code replaces it with assets only, which removes its bindings and secrets.",
      inputSchema: DeployStaticSiteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const existing = await getExisting(input.script_name);
      // Walk the directory first so local problems fail before anything is created.
      const collected = await collectAssets(input.directory);
      const worker = existing?.worker ?? (await createWorkerFor(input.script_name, input.enable_workers_dev));

      let upload: Awaited<ReturnType<typeof uploadAssets>>;
      let version: WorkerVersion;
      // An assets-only version has no code to bind to, so Cloudflare drops
      // every binding, secrets included (verified live 2026-11-06). Report it.
      const droppedSecrets = withInheritedSecrets([], existing).inherited;
      try {
        upload = await uploadAssets(workers, input.script_name, collected.files);
        const config: AssetsConfig = {
          ...(input.html_handling && { html_handling: input.html_handling }),
          ...(input.not_found_handling && { not_found_handling: input.not_found_handling }),
          ...(input.base_path && { base_path: input.base_path }),
          ...(collected.headers !== undefined && { _headers: collected.headers }),
          ...(collected.redirects !== undefined && { _redirects: collected.redirects }),
        };
        const body: VersionBody = {
          compatibility_date:
            input.compatibility_date ?? existing?.liveVersion?.compatibility_date ?? todayISO(),
          assets: {
            jwt: upload.completionJwt,
            ...(Object.keys(config).length > 0 && { config }),
          },
        };
        version = (await workers.createVersion(input.script_name, body, true)).result;
      } catch (error) {
        // Don't leave an empty, never-deployed Worker behind for a failed first deploy.
        if (existing === null) await workers.deleteWorker(input.script_name, true).catch(() => undefined);
        throw error;
      }

      const workersDev = await workersDevAfterDeploy(
        input.script_name,
        worker,
        input.enable_workers_dev,
        existing === null
      );

      return ok(
        {
          script_name: input.script_name,
          version_id: version?.id,
          files_total: collected.files.length,
          files_uploaded: upload.uploaded,
          files_reused: upload.skipped,
          ...(collected.hasAssetsIgnore && { files_ignored: collected.ignoredCount }),
          has_headers_file: collected.headers !== undefined,
          has_redirects_file: collected.redirects !== undefined,
          ...(droppedSecrets.length > 0 && {
            secrets_dropped: droppedSecrets,
            warning: `A static-site version has no code, so Cloudflare removed this Worker's secrets (${droppedSecrets.join(", ")}). Set them again with set_secrets after adding code back with deploy_worker.`,
          }),
          url: workersDev.url,
          note: workersDev.note,
        },
        `Deployed ${collected.files.length} file(s) (${upload.uploaded} uploaded, ${upload.skipped} unchanged` +
          (collected.hasAssetsIgnore ? `, ${collected.ignoredCount} excluded by .assetsignore` : "") +
          `)` +
          (workersDev.url ? ` — live at ${workersDev.url}` : "")
      );
    }
  );

  addTool(
    "redeploy_assets",
    {
      title: "Redeploy Assets",
      description:
        "Create and deploy a new version of an assets-only Worker that reuses its live version's files and asset config, e.g. to bump compatibility_date. It cannot change html_handling/not_found_handling/base_path; use deploy_static_site for that (unchanged files dedupe, so nothing is re-uploaded). Refuses while a staged version or a gradual rollout is pending.",
      inputSchema: RedeployAssetsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const existing = await getExisting(input.script_name);
      if (!existing) throw notFound(input.script_name);
      await assertLatestIsLive(input.script_name, existing, "redeploy");

      const compatibilityDate =
        input.compatibility_date ?? existing.liveVersion?.compatibility_date ?? todayISO();
      const version = (
        await workers.patchLatestVersion(
          input.script_name,
          {
            compatibility_date: compatibilityDate,
            annotations: patchAnnotations(`Redeploy reusing assets (compatibility_date ${compatibilityDate})`),
          },
          true
        )
      ).result;

      return ok(
        {
          script_name: input.script_name,
          version_id: version?.id,
          assets_reused: true,
          compatibility_date: compatibilityDate,
        },
        `Redeployed ${input.script_name} reusing existing assets and asset config`
      );
    }
  );

  // ========== Worker Lifecycle Tools ==========

  addTool(
    "deploy_worker",
    {
      title: "Deploy Worker",
      description:
        "Upload and deploy a Worker script (ES modules) with optional bindings (plain_text, secret_text, kv_namespace, r2_bucket, d1, assets). Replaces the Worker's code and binding set if it already exists; existing secrets are kept unless you pass a binding with the same name. Set keep_assets to retain a site's static assets while updating code. By default a new Worker is served on workers.dev.",
      inputSchema: DeployWorkerSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const mainModule = input.main_module ?? input.modules[0].name;
      if (!input.modules.some((m) => m.name === mainModule)) {
        throw new Error(
          `main_module "${mainModule}" does not match any provided module name (${input.modules.map((m) => m.name).join(", ")}).`
        );
      }

      const existing = await getExisting(input.script_name);
      if (input.keep_assets && !existing) {
        throw new Error(`keep_assets keeps an existing Worker's assets, but ${input.script_name} doesn't exist yet.`);
      }
      const { bindings, inherited } = withInheritedSecrets(input.bindings ?? [], existing);
      const code: VersionBody = {
        main_module: mainModule,
        modules: toVersionModules(input.modules),
        bindings,
        compatibility_date:
          input.compatibility_date ?? existing?.liveVersion?.compatibility_date ?? todayISO(),
        compatibility_flags: input.compatibility_flags ?? [],
      };
      const observability =
        input.enable_observability !== undefined ? { observability: { enabled: input.enable_observability } } : {};

      const worker = existing?.worker ?? (await createWorkerFor(input.script_name, input.enable_workers_dev, observability));
      let version: WorkerVersion;
      if (input.keep_assets) {
        await assertLatestIsLive(input.script_name, existing!, "keep its assets");
        version = (
          await workers.patchLatestVersion(
            input.script_name,
            { ...code, annotations: patchAnnotations("Deploy code, keeping assets") },
            true
          )
        ).result;
      } else {
        try {
          version = (await workers.createVersion(input.script_name, code, true)).result;
        } catch (error) {
          // Don't leave an empty, never-deployed Worker behind for a failed first deploy.
          if (existing === null) await workers.deleteWorker(input.script_name, true).catch(() => undefined);
          throw error;
        }
      }
      if (existing && input.enable_observability !== undefined) {
        await patchWorkerAfterDeploy(input.script_name, observability, version?.id);
      }

      const workersDev = await workersDevAfterDeploy(
        input.script_name,
        worker,
        input.enable_workers_dev,
        existing === null
      );

      return ok(
        {
          script_name: input.script_name,
          version_id: version?.id,
          main_module: mainModule,
          modules: input.modules.map((m) => m.name),
          bindings: (input.bindings ?? []).map((b) => ({ type: b.type, name: b.name })),
          ...(inherited.length > 0 && { secrets_kept: inherited }),
          compatibility_date: code.compatibility_date,
          url: workersDev.url,
          note: workersDev.note,
        },
        `Deployed ${input.script_name}` + (workersDev.url ? ` — live at ${workersDev.url}` : "")
      );
    }
  );


  addTool(
    "delete_worker",
    {
      title: "Delete Worker",
      description:
        "Permanently delete a Worker script, including its versions, deployments, and any static assets. Set force to delete even when other resources depend on it.",
      inputSchema: DeleteWorkerSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      await workers.deleteWorker(input.script_name, input.force);
      return ok(
        { script_name: input.script_name, deleted: true },
        `Deleted Worker '${input.script_name}'`
      );
    }
  );

  addTool(
    "update_worker_settings",
    {
      title: "Update Worker Settings",
      description:
        "Update a Worker's settings (bindings, compatibility date/flags, logpush, observability) without re-uploading its code. Bindings REPLACE the Worker's full binding set, except that existing secrets are kept unless listed. Binding and compatibility changes deploy a new version; refuses while a staged version or a gradual rollout is pending.",
      inputSchema: UpdateWorkerSettingsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { script_name, bindings, compatibility_date, compatibility_flags, logpush, observability } = input;
      if (
        bindings === undefined &&
        compatibility_date === undefined &&
        compatibility_flags === undefined &&
        logpush === undefined &&
        observability === undefined
      ) {
        throw new Error(
          "No updatable fields provided. Specify at least one of: bindings, compatibility_date, compatibility_flags, logpush, observability."
        );
      }

      const existing = await getExisting(script_name);
      if (!existing) throw notFound(script_name);

      // Version-level fields: a new version from the live one (merge patch).
      const changed = [
        ...(bindings ? ["bindings"] : []),
        ...(compatibility_date ? ["compatibility_date"] : []),
        ...(compatibility_flags ? ["compatibility_flags"] : []),
      ];
      let version: WorkerVersion | undefined;
      let kept: string[] = [];
      if (changed.length > 0) {
        await assertLatestIsLive(script_name, existing, "update its settings");
        const withSecrets = bindings ? withInheritedSecrets(bindings, existing) : undefined;
        kept = withSecrets?.inherited ?? [];
        version = (
          await workers.patchLatestVersion(
            script_name,
            {
              ...(withSecrets && { bindings: withSecrets.bindings }),
              ...(compatibility_date && { compatibility_date }),
              ...(compatibility_flags && { compatibility_flags }),
              annotations: patchAnnotations(`Update settings: ${changed.join(", ")}`),
            },
            true
          )
        ).result;
      }

      // Worker-level fields.
      let worker = existing.worker;
      if (logpush !== undefined || observability !== undefined) {
        worker = await patchWorkerAfterDeploy(
          script_name,
          {
            ...(logpush !== undefined && { logpush }),
            ...(observability && { observability }),
          },
          version?.id ?? existing.liveVersionId
        );
      }

      return ok(
        {
          script_name,
          ...(version && { version_id: version.id }),
          ...(kept.length > 0 && { secrets_kept: kept }),
          settings: settingsView({
            ...existing,
            worker,
            ...(version && { liveVersion: version, liveVersionId: version.id }),
          }),
        },
        `Updated settings for '${script_name}'`
      );
    }
  );

  // ========== Version & Deployment Tools ==========

  addTool(
    "list_versions",
    {
      title: "List Versions",
      description:
        "List a Worker's 100 most recent versions (newest first): version ID, number, author, source, and deploy message/tag. Versions are immutable snapshots; use list_deployments to see which are live.",
      inputSchema: ListVersionsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const versions = ((await workers.listVersions(input.script_name)).result ?? []).map(summarizeVersion);
      return ok(
        { script_name: input.script_name, versions },
        `Found ${versions.length} version(s)`
      );
    }
  );


  addTool(
    "list_deployments",
    {
      title: "List Deployments",
      description:
        "List a Worker's deployments (newest first). Each deployment maps traffic percentages to one or more versions; the newest deployment is the live one.",
      inputSchema: ListDeploymentsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.listDeployments(input.script_name);
      const deployments = (response.result?.deployments ?? []).map(summarizeDeployment);
      return ok(
        { script_name: input.script_name, deployments },
        `Found ${deployments.length} deployment(s)`
      );
    }
  );

  addTool(
    "get_version",
    {
      title: "Get Version",
      description:
        "Get a Worker version's detail: main module, bindings, compatibility date/flags, asset config, placement and limits for that immutable snapshot.",
      inputSchema: GetVersionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const version = (await workers.getVersion(input.script_name, input.version_id)).result;
      return ok({
        script_name: input.script_name,
        version: summarizeVersion(version),
        detail: {
          main_module: version.main_module,
          compatibility_date: version.compatibility_date,
          compatibility_flags: version.compatibility_flags,
          bindings: version.bindings,
          assets_config: version.assets?.config,
          placement: version.placement,
          limits: version.limits,
          usage_model: version.usage_model,
          startup_time_ms: version.startup_time_ms,
          urls: version.urls,
        },
      });
    }
  );

  addTool(
    "create_version",
    {
      title: "Create Version (staged)",
      description:
        "Upload a new Worker version WITHOUT deploying it — live traffic is unchanged until the version is referenced by create_deployment. Use for staged rollouts. Existing secrets carry over unless you pass a binding with the same name.",
      inputSchema: CreateVersionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const mainModule = input.main_module ?? input.modules[0].name;
      if (!input.modules.some((m) => m.name === mainModule)) {
        throw new Error(
          `main_module "${mainModule}" does not match any provided module name (${input.modules.map((m) => m.name).join(", ")}).`
        );
      }

      const existing = await getExisting(input.script_name);
      if (!existing) {
        throw new Error(
          `create_version stages a new version of an existing Worker, but ${input.script_name} doesn't exist. Deploy it first with deploy_worker.`
        );
      }
      const { bindings } = withInheritedSecrets(input.bindings ?? [], existing);
      const code: VersionBody = {
        main_module: mainModule,
        modules: toVersionModules(input.modules),
        bindings,
        compatibility_date:
          input.compatibility_date ?? existing.liveVersion?.compatibility_date ?? todayISO(),
        compatibility_flags: input.compatibility_flags ?? [],
      };

      let version: WorkerVersion;
      if (input.keep_assets) {
        await assertLatestIsLive(input.script_name, existing, "keep its assets");
        version = (
          await workers.patchLatestVersion(
            input.script_name,
            { ...code, annotations: patchAnnotations(input.message ?? "Staged code, keeping assets", input.tag) },
            false
          )
        ).result;
      } else {
        const annotations = {
          ...(input.message && { "workers/message": input.message }),
          ...(input.tag && { "workers/tag": input.tag }),
        };
        version = (
          await workers.createVersion(
            input.script_name,
            { ...code, ...(Object.keys(annotations).length > 0 && { annotations }) },
            false
          )
        ).result;
      }

      return ok(
        {
          script_name: input.script_name,
          version: summarizeVersion(version),
          deployed: false,
        },
        `Created staged version ${version?.number ?? ""} (${version?.id}) — deploy it with create_deployment`
      );
    }
  );


  addTool(
    "create_deployment",
    {
      title: "Create Deployment",
      description:
        "Point live traffic at Worker versions: a single version at 100%, or a gradual rollout splitting traffic across two versions (e.g. 90/10). Percentages must sum to 100.",
      inputSchema: CreateDeploymentSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const total = input.versions.reduce((sum, v) => sum + v.percentage, 0);
      if (Math.abs(total - 100) > 0.001) {
        throw new Error(`Version percentages must sum to 100 (got ${total}).`);
      }

      const response = await workers.createDeployment(
        input.script_name,
        {
          strategy: "percentage",
          versions: input.versions,
          ...(input.message && { annotations: { "workers/message": input.message } }),
        },
        input.force
      );

      return ok(
        {
          script_name: input.script_name,
          deployment: summarizeDeployment(response.result),
        },
        `Deployment created: ${input.versions.map((v) => `${v.version_id} @ ${v.percentage}%`).join(", ")}`
      );
    }
  );

  addTool(
    "rollback_worker",
    {
      title: "Rollback Worker",
      description:
        "Roll a Worker back by deploying an older version at 100% traffic. Only the 100 most recent versions are eligible; bound resources (KV, R2, D1 data) are NOT reverted.",
      inputSchema: RollbackWorkerSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.createDeployment(
        input.script_name,
        {
          strategy: "percentage",
          versions: [{ version_id: input.version_id, percentage: 100 }],
          annotations: {
            "workers/message": input.message ?? `Rollback to version ${input.version_id}`,
          },
        },
        input.force
      );

      return ok(
        {
          script_name: input.script_name,
          rolled_back_to: input.version_id,
          deployment: summarizeDeployment(response.result),
        },
        `Rolled ${input.script_name} back to version ${input.version_id}`
      );
    }
  );

  // ========== Domain & Cron Tools ==========

  addTool(
    "get_cron_triggers",
    {
      title: "Get Cron Triggers",
      description: "Get a Worker's cron triggers (scheduled events).",
      inputSchema: GetCronTriggersSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.getCronTriggers(input.script_name);
      const schedules = response.result?.schedules ?? [];
      return ok(
        { script_name: input.script_name, schedules },
        `Found ${schedules.length} cron trigger(s)`
      );
    }
  );

  addTool(
    "list_worker_domains",
    {
      title: "List Worker Domains",
      description:
        "List custom domains attached to Workers in this account. Optionally filter by Worker name, hostname, or zone.",
      inputSchema: ListWorkerDomainsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.listDomains(input);
      const domains = (response.result ?? []).map(summarizeDomain);
      return ok({ domains }, `Found ${domains.length} custom domain(s)`);
    }
  );

  addTool(
    "add_worker_domain",
    {
      title: "Add Worker Domain",
      description:
        "Attach a custom domain to a Worker. The domain's zone must be active in this Cloudflare account (external zones are not supported); Cloudflare creates the DNS record and certificate automatically.",
      inputSchema: AddWorkerDomainSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.attachDomain(input);
      return ok(
        { domain: summarizeDomain(response.result) },
        `Attached ${input.hostname} to ${input.service} — DNS and TLS may take a few minutes to propagate`
      );
    }
  );

  addTool(
    "delete_worker_domain",
    {
      title: "Delete Worker Domain",
      description:
        "Detach a custom domain from its Worker. The hostname stops routing to the Worker (and its previews).",
      inputSchema: DeleteWorkerDomainSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      await workers.detachDomain(input.domain_id);
      return ok(
        { domain_id: input.domain_id, deleted: true },
        `Detached domain ${input.domain_id}`
      );
    }
  );

  addTool(
    "set_workers_dev",
    {
      title: "Set workers.dev Serving",
      description:
        "Enable or disable serving a Worker on its <script_name>.<account>.workers.dev subdomain, and optionally version preview URLs.",
      inputSchema: SetWorkersDevSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const current = (await workers.getWorker(input.script_name)).result?.subdomain;
      const sub = (
        await workers.patchWorker(input.script_name, {
          subdomain: {
            enabled: input.enabled,
            previews_enabled: input.previews_enabled ?? current?.previews_enabled ?? false,
          },
        })
      ).result?.subdomain;
      const url = sub?.enabled ? sub.url : undefined;

      return ok(
        {
          script_name: input.script_name,
          enabled: sub?.enabled,
          previews_enabled: sub?.previews_enabled,
          url,
        },
        input.enabled
          ? `workers.dev enabled${url ? ` — ${url}` : ""}`
          : `workers.dev disabled for ${input.script_name}`
      );
    }
  );

  addTool(
    "set_cron_triggers",
    {
      title: "Set Cron Triggers",
      description:
        "Replace a Worker's full cron trigger set (the Worker must export a scheduled handler). Pass an empty list to remove all triggers.",
      inputSchema: SetCronTriggersSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.setCronTriggers(input.script_name, input.crons);
      const schedules = response.result?.schedules ?? [];
      return ok(
        { script_name: input.script_name, schedules },
        schedules.length === 0
          ? `Removed all cron triggers from ${input.script_name}`
          : `Set ${schedules.length} cron trigger(s) on ${input.script_name}`
      );
    }
  );

  // ========== Observability Tools ==========

  addTool(
    "query_worker_logs",
    {
      title: "Query Worker Logs",
      description:
        "Query a Worker's logs (Workers Logs / observability). Returns the most recent matching events with message, outcome, request, and timing. The Worker must have observability enabled (deploy_worker's enable_observability or update_worker_settings).",
      inputSchema: QueryWorkerLogsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const to = Date.now();
      const from = to - input.minutes * 60_000;

      const response = await workers.queryTelemetry({
        queryId: "workers-mcp-logs",
        timeframe: { from, to },
        parameters: {
          datasets: ["cloudflare-workers"],
          filters: [
            {
              key: "$metadata.service",
              operation: "eq",
              type: "string",
              value: input.script_name,
            },
            ...(input.errors_only
              ? [{ key: "$metadata.error", operation: "exists", type: "string" as const }]
              : []),
          ],
          calculations: [],
          groupBys: [],
          ...(input.search && { needle: { value: input.search, matchCase: false } }),
        },
        view: "events",
        limit: input.limit,
        ...(input.cursor && { offset: input.cursor, offsetDirection: "next" as const }),
        dry: true,
      });

      // events.count is the size of this page, not a total, so "more" is
      // inferred from a full page. Events are newest-first; the last event's
      // id is the cursor for the next (older) page.
      const events = response.result?.events?.events ?? [];
      const lastId = events[events.length - 1]?.$metadata?.id;
      const nextCursor = events.length >= input.limit ? lastId : undefined;
      return ok(
        {
          script_name: input.script_name,
          timeframe: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
          showing: events.length,
          has_more: nextCursor !== undefined,
          next_cursor: nextCursor,
          events: events.map(summarizeLogEvent),
        },
        `Retrieved ${events.length} log event(s)` +
          (nextCursor ? " — more may exist; pass next_cursor as cursor to page further back" : "") +
          (events.length === 0
            ? " — if you expected logs, check that the Worker has observability enabled and has received traffic in the window"
            : "")
      );
    }
  );

  // ========== Worker Preview Tools (beta, new Workers API) ==========

  /** Find a preview by id, slug or name; undefined if none matches. */
  async function findPreview(scriptName: string, ref: string): Promise<WorkerPreview | undefined> {
    const response = await workers.listPreviews(scriptName, { per_page: 100 });
    return (response.result ?? []).find((p) => p.id === ref || p.slug === ref || p.name === ref);
  }

  function summarizePreview(preview: WorkerPreview) {
    return {
      id: preview.id,
      name: preview.name,
      slug: preview.slug,
      url: preview.urls?.[0],
      deployed_on: preview.deployed_on ?? undefined,
    };
  }

  addTool(
    "deploy_preview",
    {
      title: "Deploy Preview",
      description:
        "Deploy a preview of an existing Worker without touching production: either a static-site directory (assets) or Worker code (modules). Returns a stable per-preview URL (https://<slug>-<worker>.<account>.workers.dev) and a per-deployment URL. Re-deploying the same preview_name updates that preview. Uses the beta Worker Previews API.",
      inputSchema: DeployPreviewSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const existing = await getExisting(input.script_name);
      if (existing === null) {
        throw new Error(
          `Worker ${input.script_name} doesn't exist. Previews attach to an existing Worker, so deploy production first (deploy_static_site or deploy_worker).`
        );
      }

      const body: VersionBody = {
        compatibility_date:
          input.compatibility_date ?? existing.liveVersion?.compatibility_date ?? todayISO(),
        ...(input.compatibility_flags && { compatibility_flags: input.compatibility_flags }),
      };
      let files: { files_total: number; files_uploaded: number; files_reused: number } | undefined;

      if (input.directory !== undefined) {
        const collected = await collectAssets(input.directory);
        const upload = await uploadAssets(workers, input.script_name, collected.files);
        const config: AssetsConfig = {
          ...(input.html_handling && { html_handling: input.html_handling }),
          ...(input.not_found_handling && { not_found_handling: input.not_found_handling }),
          ...(collected.headers !== undefined && { _headers: collected.headers }),
          ...(collected.redirects !== undefined && { _redirects: collected.redirects }),
        };
        body.assets = { jwt: upload.completionJwt, ...(Object.keys(config).length > 0 && { config }) };
        files = {
          files_total: collected.files.length,
          files_uploaded: upload.uploaded,
          files_reused: upload.skipped,
        };
      } else {
        const modules = input.modules!;
        body.main_module = input.main_module ?? modules[0].name;
        body.modules = toVersionModules(modules);
        if (input.bindings) body.bindings = input.bindings;
      }

      let note: string | undefined;
      if (input.enable_preview_urls !== false) {
        const sub = existing.worker.subdomain;
        if (!sub?.previews_enabled) {
          await workers.patchWorker(input.script_name, {
            subdomain: { enabled: sub?.enabled ?? false, previews_enabled: true },
          });
          note = "Enabled preview URLs for this Worker (production workers.dev setting unchanged).";
        }
      }

      const preview =
        (await findPreview(input.script_name, input.preview_name)) ??
        (await workers.createPreview(input.script_name, input.preview_name)).result;
      const deployment = (
        await workers.createPreviewDeployment(input.script_name, preview.id, body)
      ).result;
      // Re-read so the stable URL reflects a just-enabled previews setting.
      const fresh = (await workers.getPreview(input.script_name, preview.id)).result ?? preview;
      const previewUrl = fresh.urls?.[0];
      if (!previewUrl && !deployment.urls?.length) {
        note =
          "Deployed, but no preview URL is routable. Enable preview URLs with set_workers_dev (previews_enabled: true).";
      }

      return ok(
        {
          script_name: input.script_name,
          preview: summarizePreview(fresh),
          deployment: { id: deployment.id, url: deployment.urls?.[0] },
          ...(files ?? {}),
          note,
        },
        `Deployed preview "${fresh.name}" of ${input.script_name}` + (previewUrl ? ` at ${previewUrl}` : "")
      );
    }
  );

  addTool(
    "list_previews",
    {
      title: "List Previews",
      description: "List a Worker's previews with their stable URLs (beta Worker Previews API).",
      inputSchema: ListPreviewsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.listPreviews(input.script_name, { per_page: 100 });
      const previews = (response.result ?? []).map(summarizePreview);
      return ok(
        { script_name: input.script_name, previews },
        `${previews.length} preview(s) on ${input.script_name}`
      );
    }
  );

  addTool(
    "delete_preview",
    {
      title: "Delete Preview",
      description:
        "Delete a Worker preview and its deployments, by name, slug or id. Production is unaffected.",
      inputSchema: DeletePreviewSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const preview = await findPreview(input.script_name, input.preview);
      if (!preview) {
        throw new Error(
          `No preview "${input.preview}" on ${input.script_name}. Use list_previews to see valid names.`
        );
      }
      await workers.deletePreview(input.script_name, preview.id);
      return ok(
        { script_name: input.script_name, deleted: summarizePreview(preview) },
        `Deleted preview "${preview.name}" from ${input.script_name}`
      );
    }
  );

  // ========== Secrets Tools ==========

  addTool(
    "list_secrets",
    {
      title: "List Secrets",
      description:
        "List the secret bindings on a Worker (names and types only; Cloudflare never returns secret values).",
      inputSchema: ListSecretsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.listSecrets(input.script_name);
      const secrets = (response.result ?? []).map((s) => ({ name: s.name, type: s.type }));
      return ok(
        { script_name: input.script_name, secrets },
        `${secrets.length} secret(s) on ${input.script_name}`
      );
    }
  );

  addTool(
    "set_secrets",
    {
      title: "Set Secrets",
      description:
        "Create, update or delete secrets on a Worker without touching its code or other bindings. All changes land in ONE new version, deployed immediately. Pass a string to set a secret and null to delete it. Values are never echoed back. Secret values pass through the conversation, so for highly sensitive values prefer `wrangler secret put`.",
      inputSchema: SetSecretsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      await workers.patchSecrets(input.script_name, input.secrets);
      const names = Object.keys(input.secrets);
      const set = names.filter((name) => input.secrets[name] !== null);
      const deleted = names.filter((name) => input.secrets[name] === null);
      return ok(
        { script_name: input.script_name, set, deleted },
        `Updated secrets on ${input.script_name} (${set.length} set, ${deleted.length} deleted) in one new deployed version`
      );
    }
  );

  addTool(
    "delete_secret",
    {
      title: "Delete Secret",
      description:
        "Delete one secret binding from a Worker. This creates and deploys a new version without the secret, so code reading it will see undefined.",
      inputSchema: DeleteSecretSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      await workers.deleteSecret(input.script_name, input.name);
      return ok(
        { script_name: input.script_name, deleted: input.name },
        `Deleted secret ${input.name} from ${input.script_name}`
      );
    }
  );

  // ========== Live Tail ==========

  addTool(
    "tail_worker",
    {
      title: "Tail Worker",
      description:
        "Live-tail a Worker for a short window, like `wrangler tail`: returns requests, console logs, exceptions and outcomes as they happen. Works on any Worker; observability doesn't need to be enabled. Only traffic during the window is captured, so pass trigger_url to send a request once connected. For historical logs use query_worker_logs.",
      inputSchema: TailWorkerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, ctx) => {
      const tail = await workers.createTail(input.script_name);
      let trigger: { url: string; status?: number; error?: string } | undefined;
      try {
        const result = await collectTail({
          url: tail.result.url,
          durationMs: input.duration_seconds * 1000,
          maxEvents: input.max_events,
          errorsOnly: input.errors_only,
          search: input.search,
          signal: ctx.mcpReq.signal,
          onOpen: input.trigger_url
            ? () => {
                const record: { url: string; status?: number; error?: string } = {
                  url: input.trigger_url!,
                };
                trigger = record;
                // Fire-and-forget; the tail captures the outcome. Redirects are
                // not followed so the request never leaves the given host.
                void fetch(record.url, { redirect: "manual", signal: AbortSignal.timeout(20000) })
                  .then((response) => {
                    record.status = response.status;
                  })
                  .catch((error: unknown) => {
                    record.error = error instanceof Error ? error.message : String(error);
                  });
              }
            : undefined,
        });
        const events = result.events.map(summarizeTailEvent);
        return ok(
          {
            script_name: input.script_name,
            listened_seconds: input.duration_seconds,
            stop_reason: result.stopReason,
            captured: events.length,
            filtered_out: result.filtered,
            ...(trigger && { trigger }),
            events,
          },
          `Captured ${events.length} event(s) from ${input.script_name}` +
            (events.length === 0
              ? " (nothing hit the Worker during the window; pass trigger_url or send traffic while tailing)"
              : "")
        );
      } finally {
        // Delete eagerly so tails don't pile up against the per-Worker limit.
        await workers.deleteTail(input.script_name, tail.result.id).catch(() => undefined);
      }
    }
  );

  // ========== Utility Tools ==========

  addNoArgTool(
    "health_check",
    {
      title: "Health Check",
      description: "Verify the API token is valid and connection to Cloudflare is working. Useful for troubleshooting authentication issues.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const result = await workers.verifyToken();
      return ok(
        {
          status: result.valid ? "healthy" : "unhealthy",
          account_id: workers.getAccountId(),
          token_valid: result.valid,
          detail: result.detail,
        },
        result.valid
          ? "API connection healthy"
          : `API token check failed${result.detail ? `: ${result.detail}` : ""}`
      );
    }
  );

  return server;
}
