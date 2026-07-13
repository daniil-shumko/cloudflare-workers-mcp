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
import {
  summarizeDeployment,
  summarizeDomain,
  summarizeVersion,
  summarizeWorker,
} from "./workers/summarize.js";
import type { WorkerVersion } from "./workers/types.js";
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

const HealthCheckSchema = z.object({});

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
