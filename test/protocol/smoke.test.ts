import { test } from "node:test";
import assert from "node:assert/strict";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

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
  "tail_worker",
  "list_secrets",
  "set_secrets",
  "delete_secret",
  "deploy_preview",
  "list_previews",
  "delete_preview",
  "health_check",
].sort();

type ToolCallResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** Pull the joined text out of a CallToolResult's content array. */
function textOf(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

// SDK v2 dropped the "MCP error -32602:" prefix from rendered messages; input
// validation failures surface as isError results carrying this text.
const VALIDATION_ERROR = /Input validation error/;

/**
 * Both protocol eras the server must speak. serveStdio negotiates per
 * connection: the default Client does the 2025 `initialize` handshake; the
 * pinned client opens with the 2026-07-28 `server/discover` probe.
 */
const ERAS = [
  { era: "legacy", options: {} },
  { era: "modern", options: { versionNegotiation: { mode: { pin: "2026-07-28" } } } },
] as const;

for (const { era, options } of ERAS) {
  test(`MCP protocol smoke test over stdio, ${era} era (no real creds)`, { timeout: 30000 }, async () => {
    // Spawn the BUILT server (dist/index.js — `npm run test:protocol` builds
    // first) so the shipped artifact, including its shebang and runtime
    // package.json version read, is what gets exercised. Dummy creds make
    // every real API call fail closed, keeping the assertions below stable
    // with or without network access (CI-safe).
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "dummy-token",
        CLOUDFLARE_ACCOUNT_ID: "dummy-account",
      } as Record<string, string>,
    });

    const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {}, ...options });

    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), era, `connection should negotiate the ${era} era`);

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
        assert.equal(tool.inputSchema?.type, "object", `tool ${tool.name} should have an object inputSchema`);
        assert.ok(tool.annotations, `tool ${tool.name} should have annotations`);
        assert.equal(
          typeof tool.annotations?.readOnlyHint,
          "boolean",
          `tool ${tool.name} should have a boolean readOnlyHint annotation`
        );
      }

      // ---- zod .describe() text must survive the v2 Standard Schema conversion ----
      const getWorker = tools.find((t) => t.name === "get_worker");
      const scriptNameProp = (getWorker?.inputSchema?.properties as Record<string, { description?: string }>)
        ?.script_name;
      assert.ok(scriptNameProp?.description, "field descriptions should be advertised");

      // ---- input validation: missing required arg is rejected before the handler ----
      const missingArg = (await client.callTool({ name: "get_worker", arguments: {} })) as ToolCallResult;
      assert.equal(missingArg.isError, true, "missing required arg should be an error result");
      assert.match(textOf(missingArg), VALIDATION_ERROR, "should be an input validation error");

      // ---- base_path must be a '/'-rooted prefix; validated before the handler ----
      const badBasePath = (await client.callTool({
        name: "deploy_static_site",
        arguments: { script_name: "x", directory: ".", base_path: "blog" },
      })) as ToolCallResult;
      assert.equal(badBasePath.isError, true, "base_path without a leading '/' should be rejected");
      assert.match(textOf(badBasePath), VALIDATION_ERROR, "base_path should fail input validation");

      // ---- redeploy_assets is strict: asset config can't ride on keep_assets
      // (the API silently ignores it), so stale callers must fail loudly ----
      const staleRedeploy = (await client.callTool({
        name: "redeploy_assets",
        arguments: { script_name: "x", not_found_handling: "404-page" },
      })) as ToolCallResult;
      assert.equal(staleRedeploy.isError, true, "redeploy_assets should reject asset-config inputs");
      assert.match(textOf(staleRedeploy), VALIDATION_ERROR, "unknown keys should fail input validation");

      // ---- new-tool schemas reject bad input before any API call ----
      const rejects = async (name: string, args: Record<string, unknown>, why: string) => {
        const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
        assert.equal(result.isError, true, why);
        assert.match(textOf(result), VALIDATION_ERROR, why);
      };
      await rejects("set_secrets", { script_name: "x", secrets: {} }, "set_secrets needs at least one secret");
      await rejects(
        "tail_worker",
        { script_name: "x", trigger_url: "http://insecure.example" },
        "tail_worker trigger_url must be https"
      );
      await rejects("tail_worker", { script_name: "x", duration_seconds: 120 }, "tail window is capped");
      await rejects(
        "deploy_preview",
        { script_name: "x", preview_name: "p" },
        "deploy_preview needs a directory or modules"
      );
      await rejects(
        "deploy_preview",
        { script_name: "x", preview_name: "p", directory: ".", modules: [{ name: "a.js", content: "" }] },
        "deploy_preview rejects both directory and modules"
      );

      // ---- newer optional inputs are advertised ----
      const propsOf = (name: string) =>
        Object.keys((tools.find((t) => t.name === name)?.inputSchema?.properties ?? {}) as Record<string, unknown>);
      assert.ok(propsOf("deploy_static_site").includes("base_path"), "deploy_static_site advertises base_path");
      assert.deepEqual(
        propsOf("redeploy_assets").sort(),
        ["compatibility_date", "script_name"],
        "redeploy_assets advertises no asset-config inputs"
      );
      assert.ok(propsOf("query_worker_logs").includes("cursor"), "query_worker_logs advertises cursor");

      // ---- no-arg tools accept a call that omits `arguments` entirely ----
      const health = (await client.callTool({ name: "health_check" })) as ToolCallResult;
      const healthText = textOf(health);
      const healthPayload = JSON.parse(healthText) as { data: { token_valid: boolean } };
      assert.equal(healthPayload.data.token_valid, false, "a bogus/unreachable token should report token_valid:false");

      // ---- results also carry structuredContent mirroring the text payload ----
      const structured = (health as { structuredContent?: unknown }).structuredContent;
      assert.ok(structured, "tool results should include structuredContent");
      assert.deepEqual(structured, healthPayload, "structuredContent should mirror the JSON text payload");

      // ---- a real API call with a bad/unreachable token surfaces an error result ----
      const list = (await client.callTool({ name: "list_workers", arguments: {} })) as ToolCallResult;
      assert.equal(list.isError, true, "list_workers with a bad token should be an error result");

      // ---- v2: unknown tools reject with a protocol error instead of resolving isError ----
      await assert.rejects(
        client.callTool({ name: "no_such_tool", arguments: {} }),
        "calling an unknown tool should reject"
      );
    } finally {
      await client.close();
    }
  });
}
