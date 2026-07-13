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
import { summarizeWorker } from "./workers/summarize.js";
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
      description: "Get a Worker's settings: bindings, compatibility date and flags, placement, and observability configuration.",
      inputSchema: GetWorkerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const response = await workers.getWorkerSettings(input.script_name);
      return ok(response.result);
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
