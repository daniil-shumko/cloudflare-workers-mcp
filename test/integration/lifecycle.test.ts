/**
 * Guarded live e2e against a real Cloudflare account (mirrors
 * cloudflare-pages-mcp's lifecycle test): deploy a throwaway static site over
 * the real MCP stdio server, verify it serves over HTTP, exercise dedupe on
 * redeploy, then delete it — with best-effort cleanup even on failure.
 *
 * Skipped unless CF_LIVE_TEST=1 and real CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_ACCOUNT_ID are set (`npm run test:live`). Only creates resources
 * named cf-mcp-test-*.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { WorkersClient } from "../../src/workers/client.js";

const LIVE =
  process.env.CF_LIVE_TEST === "1" &&
  !!process.env.CLOUDFLARE_API_TOKEN &&
  !!process.env.CLOUDFLARE_ACCOUNT_ID;

interface ToolResult {
  isError: boolean;
  payload: {
    success?: boolean;
    message?: string;
    data?: Record<string, unknown> & {
      files_total?: number;
      files_uploaded?: number;
      files_reused?: number;
      url?: string;
      workers?: Array<{ name: string }>;
      versions?: Array<unknown>;
    };
    [key: string]: unknown;
  };
}

/** Poll a URL until it returns 200, bounded by `deadlineMs`. */
async function fetchUntilOk(url: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      lastStatus = response.status;
      if (response.ok) return await response.text();
    } catch {
      // DNS not propagated yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${url} did not serve within ${deadlineMs}ms (last status: ${lastStatus})`);
}

test(
  "live static-site lifecycle: deploy → serve → dedupe redeploy → delete",
  {
    skip: LIVE ? false : "set CF_LIVE_TEST=1 and CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID to run",
    timeout: 300000,
  },
  async () => {
    const scriptName = `cf-mcp-test-${Date.now().toString(36)}`;

    // A tiny throwaway site: nested path + 404 page + a _headers rule.
    const siteDir = await mkdtemp(join(tmpdir(), "cf-mcp-live-site-"));
    await writeFile(join(siteDir, "index.html"), `<h1>cf-mcp-test ${scriptName}</h1>`);
    await writeFile(join(siteDir, "404.html"), "<h1>custom not found</h1>");
    await mkdir(join(siteDir, "css"));
    await writeFile(join(siteDir, "css", "style.css"), "body{color:rebeccapurple}");
    await writeFile(join(siteDir, "_headers"), "/*\n  X-Cf-Mcp-Test: 1");

    const transport = new StdioClientTransport({
      command: "node",
      args: ["--import", "tsx", "src/index.ts"],
      env: { ...(process.env as Record<string, string>) },
    });
    const client = new Client({ name: "live", version: "0.0.0" }, { capabilities: {} });
    // Direct API client for cleanup (the delete_worker tool arrives with M3;
    // switch cleanup to the tool then, keeping this as the finally-fallback).
    const direct = new WorkersClient(
      process.env.CLOUDFLARE_API_TOKEN!,
      process.env.CLOUDFLARE_ACCOUNT_ID!
    );

    let needsCleanup: string | null = null;

    async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const result = await client.callTool({ name, arguments: args });
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { isError: !!result.isError, payload: JSON.parse(text) };
    }

    try {
      await client.connect(transport);

      // Fail fast on bad creds before creating anything.
      const health = await call("health_check", {});
      assert.equal(
        (health.payload.data as { token_valid?: boolean }).token_valid,
        true,
        "health_check failed — check the live-test credentials"
      );

      // Mark for cleanup BEFORE the deploy: a partially failed deploy can
      // still have created the script.
      needsCleanup = scriptName;
      const deploy = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
        not_found_handling: "404-page",
      });
      assert.equal(deploy.isError, false, `deploy failed: ${JSON.stringify(deploy.payload)}`);
      assert.equal(deploy.payload.data?.files_total, 3, "manifest should exclude _headers");
      assert.equal(deploy.payload.data?.files_uploaded, 3);

      // It should actually serve — the assets-only Worker (no main_module)
      // being valid is exactly what this live test exists to confirm (M2).
      const url = deploy.payload.data?.url;
      assert.ok(url, `expected a workers.dev URL, got: ${JSON.stringify(deploy.payload.data)}`);
      const body = await fetchUntilOk(url, 180000);
      assert.match(body, new RegExp(scriptName), "served page should be the deployed index.html");

      // Server-side dedupe: an unchanged redeploy uploads nothing.
      const redeploy = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
      });
      assert.equal(redeploy.isError, false, `redeploy failed: ${JSON.stringify(redeploy.payload)}`);
      assert.equal(redeploy.payload.data?.files_uploaded, 0, "unchanged files should dedupe");
      assert.equal(redeploy.payload.data?.files_reused, 3);

      // Read-back through the read-only surface.
      const list = await call("list_workers", {});
      assert.ok(
        list.payload.data?.workers?.some((w) => w.name === scriptName),
        "deployed Worker should appear in list_workers"
      );
      const versions = await call("list_versions", { script_name: scriptName });
      assert.ok((versions.payload.data?.versions?.length ?? 0) >= 2, "each deploy creates a version");

      // Delete and unmark cleanup.
      await direct.deleteWorker(scriptName, true);
      needsCleanup = null;
    } finally {
      if (needsCleanup) {
        try {
          await direct.deleteWorker(needsCleanup, true);
        } catch {
          // Best-effort cleanup; don't mask the real assertion failure.
        }
      }
      await client.close();
      await rm(siteDir, { recursive: true, force: true });
    }
  }
);
