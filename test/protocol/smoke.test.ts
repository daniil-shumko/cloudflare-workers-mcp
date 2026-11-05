import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "list_workers",
  "get_worker",
  "get_worker_code",
  "deploy_static_site",
  "redeploy_assets",
  "deploy_worker",
  "delete_worker",
  "update_worker_settings",
  "list_versions",
  "get_version",
  "create_version",
  "list_deployments",
  "create_deployment",
  "rollback_worker",
  "get_cron_triggers",
  "set_cron_triggers",
  "list_worker_domains",
  "add_worker_domain",
  "delete_worker_domain",
  "set_workers_dev",
  "query_worker_logs",
  "health_check",
].sort();

/** Pull the joined text out of a CallToolResult's content array. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("MCP protocol smoke test over stdio (no real creds)", { timeout: 30000 }, async () => {
  // Spawn the BUILT server (dist/index.js — `npm run test:protocol` builds
  // first) so the shipped artifact, including its shebang and runtime
  // package.json version read, is what gets exercised. Dummy creds make every
  // real API call fail closed, keeping the assertions below stable with or
  // without network access (CI-safe).
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "dummy-token",
      CLOUDFLARE_ACCOUNT_ID: "dummy-account",
    },
  });

  const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);

    // ---- listTools ----
    const { tools } = await client.listTools();

    assert.equal(
      tools.length,
      EXPECTED_TOOLS.length,
      `server should advertise exactly ${EXPECTED_TOOLS.length} tools`
    );

    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, "advertised tool names must match the expected set");

    for (const tool of tools) {
      assert.equal(
        tool.inputSchema?.type,
        "object",
        `tool ${tool.name} should have an object inputSchema`
      );
      assert.ok(tool.annotations, `tool ${tool.name} should have annotations`);
      assert.equal(
        typeof tool.annotations?.readOnlyHint,
        "boolean",
        `tool ${tool.name} should have a boolean readOnlyHint annotation`
      );
    }

    // ---- input validation: missing required arg is rejected before the handler ----
    const missingArg = await client.callTool({ name: "get_worker", arguments: {} });
    assert.equal(missingArg.isError, true, "missing required arg should be an error result");
    assert.match(
      textOf(missingArg as { content?: Array<{ type: string; text?: string }> }),
      /-32602/,
      "validation error should surface the -32602 invalid-params code"
    );

    // ---- base_path must be a '/'-rooted prefix; validated before the handler ----
    const badBasePath = await client.callTool({
      name: "deploy_static_site",
      arguments: { script_name: "x", directory: ".", base_path: "blog" },
    });
    assert.equal(badBasePath.isError, true, "base_path without a leading '/' should be rejected");
    assert.match(
      textOf(badBasePath as { content?: Array<{ type: string; text?: string }> }),
      /-32602/,
      "base_path validation should surface the -32602 invalid-params code"
    );

    // ---- redeploy_assets is strict: asset config can't ride on keep_assets
    // (the API silently ignores it), so stale callers must fail loudly ----
    const staleRedeploy = await client.callTool({
      name: "redeploy_assets",
      arguments: { script_name: "x", not_found_handling: "404-page" },
    });
    assert.equal(staleRedeploy.isError, true, "redeploy_assets should reject asset-config inputs");
    assert.match(
      textOf(staleRedeploy as { content?: Array<{ type: string; text?: string }> }),
      /-32602/,
      "unknown redeploy_assets keys should surface the -32602 invalid-params code"
    );

    // ---- newer optional inputs are advertised ----
    const propsOf = (name: string) =>
      Object.keys(
        (tools.find((t) => t.name === name)?.inputSchema?.properties ?? {}) as Record<string, unknown>
      );
    assert.ok(propsOf("deploy_static_site").includes("base_path"), "deploy_static_site advertises base_path");
    assert.deepEqual(
      propsOf("redeploy_assets").sort(),
      ["compatibility_date", "script_name"],
      "redeploy_assets advertises no asset-config inputs"
    );
    assert.ok(propsOf("query_worker_logs").includes("cursor"), "query_worker_logs advertises cursor");

    // ---- health_check never crashes; a bogus/unreachable token yields token_valid:false ----
    const health = await client.callTool({ name: "health_check", arguments: {} });
    const healthText = textOf(health as { content?: Array<{ type: string; text?: string }> });
    const healthPayload = JSON.parse(healthText) as { data: { token_valid: boolean } };
    assert.equal(
      healthPayload.data.token_valid,
      false,
      "a bogus/unreachable token should report token_valid:false"
    );

    // ---- results also carry structuredContent mirroring the text payload ----
    const structured = (health as { structuredContent?: unknown }).structuredContent;
    assert.ok(structured, "tool results should include structuredContent");
    assert.deepEqual(
      structured,
      healthPayload,
      "structuredContent should mirror the JSON text payload"
    );

    // ---- a real API call with a bad/unreachable token surfaces an error result ----
    const list = await client.callTool({ name: "list_workers", arguments: {} });
    assert.equal(list.isError, true, "list_workers with a bad token should be an error result");
  } finally {
    await client.close();
  }
});
