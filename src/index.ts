#!/usr/bin/env node

/**
 * Cloudflare Workers MCP Server: stdio entry point.
 *
 * A Model Context Protocol server for managing Cloudflare Workers: deploying
 * static sites and Worker scripts, and managing versions, deployments, custom
 * domains, cron triggers, secrets, logs and previews. Tools live in
 * `server.ts`; this file only loads config and serves stdio.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { WorkersClient } from "./workers/client.js";
import { loadConfig } from "./utils/config.js";
import { buildServer, SERVER_VERSION } from "./server.js";

// ==================== Entry ====================

async function main() {
  const config = loadConfig();
  const workers = new WorkersClient(config.apiToken, config.accountId);

  // serveStdio (SDK v2) negotiates the protocol era per connection: it serves
  // 2026-07-28 clients (server/discover) and 2025-era clients (initialize)
  // from the same factory. A bare server.connect(new StdioServerTransport())
  // would only ever speak the 2025 protocol.
  const handle = serveStdio(() => buildServer(workers));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }

  // Log to stderr (stdout is reserved for the MCP protocol).
  console.error(`Cloudflare Workers MCP Server v${SERVER_VERSION} started`);
  console.error(`Account ID: ${config.accountId}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
