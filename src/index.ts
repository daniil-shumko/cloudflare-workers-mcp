#!/usr/bin/env node

/**
 * Cloudflare Workers MCP Server
 *
 * A Model Context Protocol server for managing Cloudflare Workers: deploying
 * static sites and Worker scripts, and managing versions, deployments, custom
 * domains, and cron triggers.
 * Connects via stdio transport for use with Claude Desktop and Claude Code.
 *
 * Current state: read-only skeleton (list_workers, get_worker, health_check).
 * The full tool surface is specified in IMPLEMENTATION_PLAN.md.
 */

import { readFileSync } from "node:fs";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { WorkersClient } from "./workers/client.js";
import { collectAssets, uploadAssets } from "./workers/assets.js";
import {
  summarizeDeployment,
  summarizeDomain,
  summarizeVersion,
  summarizeWorker,
} from "./workers/summarize.js";
import type { AssetsConfig, ScriptUploadMetadata, WorkerVersion } from "./workers/types.js";
import { loadConfig } from "./utils/config.js";
import { formatError, formatSuccess } from "./utils/errors.js";

// Read the package version at runtime (dist/index.js -> ../package.json). npm
// always ships package.json, so this resolves both in dev and when installed.
const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

// ==================== Tool Input Schemas ====================
//
// Each tool's input contract is a single Zod schema. The schema is handed to
// `registerTool` as-is (the SDK generates the advertised JSON Schema and
// validates inputs before the handler runs), and `z.infer` types the handler
// arguments. There is intentionally no second, hand-written JSON Schema copy.

const ListWorkersSchema = z.object({});

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

const DeployStaticSiteSchema = z.object({
  script_name: z
    .string()
    .describe("Worker name to deploy the site as (lowercase, alphanumeric and hyphens)"),
  directory: z
    .string()
    .describe("Path to the built site directory to upload (absolute path recommended)"),
  html_handling: HtmlHandlingSchema,
  not_found_handling: NotFoundHandlingSchema,
  compatibility_date: z
    .string()
    .optional()
    .describe("Worker compatibility date (YYYY-MM-DD); defaults to today"),
  enable_workers_dev: z
    .boolean()
    .optional()
    .default(true)
    .describe("Serve the site at <script_name>.<account>.workers.dev after deploying (default true)"),
});

const RedeployAssetsSchema = z.object({
  script_name: z.string().describe("The name of the Worker script"),
  html_handling: HtmlHandlingSchema,
  not_found_handling: NotFoundHandlingSchema,
  compatibility_date: z
    .string()
    .optional()
    .describe("Worker compatibility date (YYYY-MM-DD); defaults to today"),
});

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
  compatibility_flags: z.array(z.string()).optional(),
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
    .default(true)
    .describe("Serve the Worker at <script_name>.<account>.workers.dev after deploying (default true)"),
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
  compatibility_flags: z.array(z.string()).optional(),
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
  compatibility_flags: z.array(z.string()).optional(),
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

const HealthCheckSchema = z.object({});

/** Today as YYYY-MM-DD — the default compatibility_date for new uploads. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the multipart body for a script upload: a `metadata` JSON part plus
 * one part per module (none for an assets-only Worker). Module part names are
 * the filenames that metadata.main_module references.
 */
function scriptUploadForm(
  metadata: ScriptUploadMetadata,
  modules: Array<{ name: string; content: string; content_type?: string }> = []
): FormData {
  const form = new FormData();
  form.append(
    "metadata",
    new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" })
  );
  for (const mod of modules) {
    form.append(
      mod.name,
      new File([mod.content], mod.name, {
        type: mod.content_type ?? "application/javascript+module",
      })
    );
  }
  return form;
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

async function main() {
  const config = loadConfig();
  const workers = new WorkersClient(config.apiToken, config.accountId);

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
    handler: (args: z.infer<S>) => Promise<CallToolResult>
  ): void {
    // ToolCallback<S> is a conditional type that TypeScript cannot reduce for
    // an unresolved generic S, so the wrapper needs one cast to the SDK's own
    // callback type; args is the schema's already-validated output.
    const wrapped = (async (args: z.infer<S>): Promise<CallToolResult> => {
      try {
        return await handler(args);
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

  // ========== Worker Tools ==========

  addTool(
    "list_workers",
    {
      title: "List Workers",
      description: "List all Worker scripts in your account. Returns each Worker's name, timestamps, and whether it serves static assets.",
      inputSchema: ListWorkersSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const response = await workers.listWorkers();
      // Some Cloudflare v4 list endpoints return null (not []) for empty
      // collections, and the client itself yields result:null for empty bodies.
      const scripts = (response.result ?? []).map(summarizeWorker);
      return ok(
        {
          workers: scripts,
          account_id: workers.getAccountId(),
        },
        `Found ${scripts.length} Worker(s)`
      );
    }
  );

  addTool(
    "get_worker",
    {
      title: "Get Worker",
      description:
        "Get a Worker's settings (bindings, compatibility date and flags, placement, observability) plus its cron triggers and workers.dev subdomain status.",
      inputSchema: GetWorkerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      // Settings are the core payload; cron triggers and subdomain status are
      // folded in best-effort — a failure there (e.g. a token scoped to
      // scripts only) degrades to a note instead of failing the whole tool.
      const [settings, schedules, subdomain, accountSubdomain] = await Promise.allSettled([
        workers.getWorkerSettings(input.script_name),
        workers.getCronTriggers(input.script_name),
        workers.getScriptSubdomain(input.script_name),
        workers.getAccountSubdomain(),
      ]);

      if (settings.status === "rejected") {
        throw settings.reason;
      }

      const cron =
        schedules.status === "fulfilled"
          ? (schedules.value.result?.schedules ?? []).map((s) => s.cron)
          : undefined;

      let workersDev: { enabled?: boolean; previews_enabled?: boolean; url?: string } | undefined;
      if (subdomain.status === "fulfilled") {
        const sub = subdomain.value.result ?? {};
        workersDev = { enabled: sub.enabled, previews_enabled: sub.previews_enabled };
        const accountSub =
          accountSubdomain.status === "fulfilled"
            ? accountSubdomain.value.result?.subdomain
            : undefined;
        if (sub.enabled && accountSub) {
          workersDev.url = `https://${input.script_name}.${accountSub}.workers.dev`;
        }
      }

      return ok({
        script_name: input.script_name,
        settings: settings.value.result,
        cron_triggers: cron,
        workers_dev: workersDev,
      });
    }
  );

  addTool(
    "get_worker_code",
    {
      title: "Get Worker Code",
      description:
        "Download a Worker's deployed source code. Module-syntax Workers return one entry per module; service-worker-syntax Workers return a single script.",
      inputSchema: GetWorkerCodeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { contentType, modules } = await workers.downloadWorkerCode(input.script_name);
      return ok(
        {
          script_name: input.script_name,
          content_type: contentType || undefined,
          modules: modules.map((m) => ({
            name: m.name,
            content_type: m.content_type,
            size: Buffer.byteLength(m.content, "utf8"),
            content: m.content,
          })),
        },
        `Fetched ${modules.length} module(s)`
      );
    }
  );

  // ========== Static Site Tools ==========

  /**
   * Best-effort workers.dev enablement after a deploy. Returns the public URL
   * when everything succeeds, otherwise a note explaining what to do manually.
   */
  async function enableWorkersDev(
    scriptName: string
  ): Promise<{ url?: string; note?: string }> {
    try {
      await workers.setScriptSubdomain(scriptName, true);
      const account = await workers.getAccountSubdomain();
      const sub = account.result?.subdomain;
      return sub
        ? { url: `https://${scriptName}.${sub}.workers.dev` }
        : { note: "workers.dev enabled, but the account has no workers.dev subdomain registered yet." };
    } catch (error) {
      return {
        note: `Deployed, but enabling workers.dev failed: ${error instanceof Error ? error.message : String(error)}. Enable it with set_workers_dev or attach a custom domain.`,
      };
    }
  }

  addTool(
    "deploy_static_site",
    {
      title: "Deploy Static Site",
      description:
        "Deploy a local directory as a static site on Workers (assets-only Worker): builds the file manifest, uploads only files Cloudflare doesn't already have, and deploys. By default the site is served on workers.dev. Set not_found_handling to 'single-page-application' for SPAs. A _headers or _redirects file at the directory root is applied as configuration, not uploaded.",
      inputSchema: DeployStaticSiteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const collected = await collectAssets(input.directory);
      const upload = await uploadAssets(workers, input.script_name, collected.files);

      const config: AssetsConfig = {
        ...(input.html_handling && { html_handling: input.html_handling }),
        ...(input.not_found_handling && { not_found_handling: input.not_found_handling }),
        ...(collected.headers !== undefined && { _headers: collected.headers }),
        ...(collected.redirects !== undefined && { _redirects: collected.redirects }),
      };
      const metadata: ScriptUploadMetadata = {
        assets: {
          jwt: upload.completionJwt,
          ...(Object.keys(config).length > 0 && { config }),
        },
        compatibility_date: input.compatibility_date ?? todayISO(),
      };

      await workers.uploadScript(input.script_name, scriptUploadForm(metadata));

      const workersDev = input.enable_workers_dev
        ? await enableWorkersDev(input.script_name)
        : {};

      return ok(
        {
          script_name: input.script_name,
          files_total: collected.files.length,
          files_uploaded: upload.uploaded,
          files_reused: upload.skipped,
          has_headers_file: collected.headers !== undefined,
          has_redirects_file: collected.redirects !== undefined,
          url: workersDev.url,
          note: workersDev.note,
        },
        `Deployed ${collected.files.length} file(s) (${upload.uploaded} uploaded, ${upload.skipped} unchanged)` +
          (workersDev.url ? ` — live at ${workersDev.url}` : "")
      );
    }
  );

  addTool(
    "redeploy_assets",
    {
      title: "Redeploy Assets",
      description:
        "Create a new deployment of an assets-only Worker that reuses its previously uploaded files (keep_assets) — useful to change html_handling or not_found_handling without re-uploading the site.",
      inputSchema: RedeployAssetsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const config: AssetsConfig = {
        ...(input.html_handling && { html_handling: input.html_handling }),
        ...(input.not_found_handling && { not_found_handling: input.not_found_handling }),
      };
      const metadata: ScriptUploadMetadata = {
        keep_assets: true,
        ...(Object.keys(config).length > 0 && { assets: { config } }),
        compatibility_date: input.compatibility_date ?? todayISO(),
      };

      await workers.uploadScript(input.script_name, scriptUploadForm(metadata));

      return ok(
        {
          script_name: input.script_name,
          assets_reused: true,
          config_applied: Object.keys(config).length > 0 ? config : undefined,
        },
        `Redeployed ${input.script_name} reusing existing assets`
      );
    }
  );

  // ========== Worker Lifecycle Tools ==========

  addTool(
    "deploy_worker",
    {
      title: "Deploy Worker",
      description:
        "Upload and deploy a Worker script (ES modules) with optional bindings (plain_text, secret_text, kv_namespace, r2_bucket, d1, assets). Replaces the Worker's code and binding set if it already exists. Set keep_assets to retain a site's static assets while updating code. By default the Worker is served on workers.dev.",
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

      const metadata: ScriptUploadMetadata = {
        main_module: mainModule,
        ...(input.bindings && { bindings: input.bindings }),
        compatibility_date: input.compatibility_date ?? todayISO(),
        ...(input.compatibility_flags && { compatibility_flags: input.compatibility_flags }),
        ...(input.keep_assets !== undefined && { keep_assets: input.keep_assets }),
        ...(input.enable_observability !== undefined && {
          observability: { enabled: input.enable_observability },
        }),
      };

      const response = await workers.uploadScript(
        input.script_name,
        scriptUploadForm(metadata, input.modules)
      );

      const workersDev = input.enable_workers_dev
        ? await enableWorkersDev(input.script_name)
        : {};

      return ok(
        {
          script_name: input.script_name,
          main_module: mainModule,
          modules: input.modules.map((m) => m.name),
          bindings: (input.bindings ?? []).map((b) => ({ type: b.type, name: b.name })),
          compatibility_date: metadata.compatibility_date,
          etag: response.result?.etag,
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
        "Update a Worker's settings (bindings, compatibility date/flags, logpush, observability) without re-uploading its code. Note: bindings REPLACE the Worker's full binding set.",
      inputSchema: UpdateWorkerSettingsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { script_name, ...fields } = input;
      const settings = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
      );
      if (Object.keys(settings).length === 0) {
        throw new Error(
          "No updatable fields provided. Specify at least one of: bindings, compatibility_date, compatibility_flags, logpush, observability."
        );
      }

      const response = await workers.patchWorkerSettings(script_name, settings);
      return ok(
        { script_name, settings: response.result },
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
        "List a Worker's versions (newest first): version ID, number, author, source, and deploy message. Versions are immutable snapshots; use list_deployments to see which are live.",
      inputSchema: ListVersionsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.listVersions(input.script_name);
      // The documented shape is { items: [...] }; tolerate a bare array too.
      const items: WorkerVersion[] = Array.isArray(response.result)
        ? response.result
        : (response.result?.items ?? []);
      const versions = items.map(summarizeVersion);
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
        "Get a Worker version's detail: bindings, compatibility date/flags, handlers, and usage model for that immutable snapshot.",
      inputSchema: GetVersionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.getVersion(input.script_name, input.version_id);
      const version = response.result;
      return ok({
        script_name: input.script_name,
        version: summarizeVersion(version),
        resources: version.resources,
      });
    }
  );

  addTool(
    "create_version",
    {
      title: "Create Version (staged)",
      description:
        "Upload a new Worker version WITHOUT deploying it — live traffic is unchanged until the version is referenced by create_deployment. Use for staged rollouts.",
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

      const annotations: { "workers/message"?: string; "workers/tag"?: string } = {
        ...(input.message && { "workers/message": input.message }),
        ...(input.tag && { "workers/tag": input.tag }),
      };
      const metadata: ScriptUploadMetadata = {
        main_module: mainModule,
        ...(input.bindings && { bindings: input.bindings }),
        compatibility_date: input.compatibility_date ?? todayISO(),
        ...(input.compatibility_flags && { compatibility_flags: input.compatibility_flags }),
        ...(input.keep_assets !== undefined && { keep_assets: input.keep_assets }),
        ...(Object.keys(annotations).length > 0 && { annotations }),
      };

      const response = await workers.createVersion(
        input.script_name,
        scriptUploadForm(metadata, input.modules)
      );

      return ok(
        {
          script_name: input.script_name,
          version: summarizeVersion(response.result),
          deployed: false,
        },
        `Created staged version ${response.result?.number ?? ""} (${response.result?.id}) — deploy it with create_deployment`
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
      const response = await workers.setScriptSubdomain(
        input.script_name,
        input.enabled,
        input.previews_enabled
      );

      let url: string | undefined;
      if (response.result?.enabled) {
        try {
          const account = await workers.getAccountSubdomain();
          const sub = account.result?.subdomain;
          if (sub) url = `https://${input.script_name}.${sub}.workers.dev`;
        } catch {
          // URL is a convenience; the setting itself succeeded.
        }
      }

      return ok(
        {
          script_name: input.script_name,
          enabled: response.result?.enabled,
          previews_enabled: response.result?.previews_enabled,
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

  // ========== Utility Tools ==========

  addTool(
    "health_check",
    {
      title: "Health Check",
      description: "Verify the API token is valid and connection to Cloudflare is working. Useful for troubleshooting authentication issues.",
      inputSchema: HealthCheckSchema,
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

  // Connect via stdio transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for the MCP protocol).
  console.error(`Cloudflare Workers MCP Server v${SERVER_VERSION} started`);
  console.error(`Account ID: ${config.accountId}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
