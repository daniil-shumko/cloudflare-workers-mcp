/**
 * Handler-level tests: the real buildServer() driven by a real MCP client
 * over an in-memory transport, against a route-based fake Cloudflare API.
 *
 * These cover the decision logic the live e2e can't trigger on demand:
 * cleanup after a failed first deploy, Worker-level PATCH failures after a
 * version is already live, the staged-version guard, secret inheritance and
 * the static-site secrets warning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildServer } from "../../src/server.js";
import { WorkersClient } from "../../src/workers/client.js";

const ACCOUNT = "acct-123";
const NAME = "cf-mcp-unit";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
type Reply = { status?: number; result?: unknown; error?: { code: number; message: string } };
type Route = (call: Call) => Reply | undefined;

/** Install a fetch fake that answers by `METHOD path` and records every call. */
function fakeCloudflare(routes: Record<string, Reply | Route>) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}/workers`, "") + url.search;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { method: init?.method ?? "GET", path, body };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    const reply = typeof route === "function" ? route(call) : route;
    if (!reply) throw new Error(`fake Cloudflare: no route for ${call.method} ${path}`);
    const status = reply.status ?? (reply.error ? 400 : 200);
    const json = reply.error
      ? { success: false, errors: [reply.error], messages: [], result: null }
      : { success: true, errors: [], messages: [], result: reply.result ?? null };
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const notFound: Reply = { status: 404, error: { code: 10007, message: "This Worker does not exist on your account." } };
const worker = (over: Record<string, unknown> = {}) => ({
  id: NAME,
  name: NAME,
  subdomain: { enabled: true, previews_enabled: false, url: `https://${NAME}.example.workers.dev` },
  ...over,
});
/** An existing Worker whose live version v-1 holds secret S plus a KV binding. */
const existingRoutes = (
  liveBindings: unknown[] = [
    { type: "secret_text", name: "S" },
    { type: "kv_namespace", name: "KV", namespace_id: "ns" },
  ]
): Record<string, Reply> => ({
  [`GET /workers/${NAME}`]: { result: worker() },
  [`GET /scripts/${NAME}/deployments`]: {
    result: { deployments: [{ id: "d-1", versions: [{ version_id: "v-1", percentage: 100 }] }] },
  },
  [`GET /workers/${NAME}/versions/v-1`]: {
    result: { id: "v-1", number: 1, compatibility_date: "2026-01-01", main_module: "index.js", bindings: liveBindings },
  },
});

async function connect() {
  const server = buildServer(new WorkersClient("test-token", ACCOUNT));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "handlers-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  return { call, close: () => client.close() };
}

async function siteDir() {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-unit-site-"));
  await writeFile(join(dir, "index.html"), "<h1>unit</h1>");
  return dir;
}

const code = { modules: [{ name: "index.js", content: "export default { fetch() { return new Response('x') } }" }] };

test("deploy_static_site deletes the Worker it just created when the deploy fails", async () => {
  const dir = await siteDir();
  const cf = fakeCloudflare({
    [`GET /workers/${NAME}`]: notFound,
    "POST /workers": { result: worker() },
    [`POST /scripts/${NAME}/assets-upload-session`]: { result: { jwt: "session-jwt", buckets: [] } },
    [`POST /workers/${NAME}/versions?deploy=true`]: { error: { code: 10021, message: "validation failed" } },
    [`DELETE /workers/${NAME}?force=true`]: { result: null },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_static_site", { script_name: NAME, directory: dir });
    assert.equal(res.isError, true);
    assert.equal(res.payload.code, "CF_10021", "the original deploy error surfaces, not the cleanup");
    assert.ok(cf.calls.some((c) => c.method === "DELETE" && c.path === `/workers/${NAME}?force=true`), "orphan removed");
  } finally {
    await mcp.close();
    cf.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy_static_site never deletes an existing Worker when its deploy fails", async () => {
  const dir = await siteDir();
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`POST /scripts/${NAME}/assets-upload-session`]: { result: { jwt: "session-jwt", buckets: [] } },
    [`POST /workers/${NAME}/versions?deploy=true`]: { error: { code: 10021, message: "validation failed" } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_static_site", { script_name: NAME, directory: dir });
    assert.equal(res.isError, true);
    assert.ok(!cf.calls.some((c) => c.method === "DELETE"));
  } finally {
    await mcp.close();
    cf.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy_static_site over a code Worker warns that its secrets are dropped", async () => {
  const dir = await siteDir();
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`POST /scripts/${NAME}/assets-upload-session`]: { result: { jwt: "session-jwt", buckets: [] } },
    [`POST /workers/${NAME}/versions?deploy=true`]: { result: { id: "v-2", number: 2 } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_static_site", { script_name: NAME, directory: dir });
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.deepEqual(res.payload.data.secrets_dropped, ["S"]);
    assert.match(res.payload.data.warning, /set_secrets/);
    const body = cf.calls.find((c) => c.method === "POST" && c.path.includes("/versions"))?.body as Record<string, unknown>;
    assert.equal(body.bindings, undefined, "an assets-only version sends no bindings");
    assert.equal(body.compatibility_date, "2026-01-01", "compat date inherited from the live version");
  } finally {
    await mcp.close();
    cf.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy_worker keeps the live version's secrets via pinned inherit bindings", async () => {
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`POST /workers/${NAME}/versions?deploy=true`]: { result: { id: "v-2", number: 2 } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", {
      script_name: NAME,
      ...code,
      bindings: [{ type: "plain_text", name: "LABEL", text: "x" }],
    });
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.deepEqual(res.payload.data.secrets_kept, ["S"]);
    const body = cf.calls.find((c) => c.method === "POST")?.body as { bindings: unknown[] };
    assert.deepEqual(body.bindings, [
      { type: "plain_text", name: "LABEL", text: "x" },
      { type: "inherit", name: "S", version_id: "v-1" },
    ]);
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("deploy_worker uploads a module from a local file path (issue #1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-unit-mod-"));
  const src = "export default { fetch() { return new Response('from disk') } }";
  await writeFile(join(dir, "worker.js"), src);
  const cf = fakeCloudflare({
    ...existingRoutes([]),
    [`POST /workers/${NAME}/versions?deploy=true`]: { result: { id: "v-2", number: 2 } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", { script_name: NAME, modules: [{ path: join(dir, "worker.js") }] });
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload.data.main_module, "worker.js");
    assert.deepEqual(res.payload.data.modules, ["worker.js"]);
    const body = cf.calls.find((c) => c.method === "POST")?.body as {
      main_module: string;
      modules: Array<{ name: string; content_base64: string }>;
    };
    assert.equal(body.main_module, "worker.js");
    assert.equal(Buffer.from(body.modules[0].content_base64, "base64").toString("utf8"), src);
  } finally {
    await mcp.close();
    cf.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy_worker with a missing module file fails before creating anything", async () => {
  const cf = fakeCloudflare({});
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", { script_name: NAME, modules: [{ path: "/nonexistent/cf-mcp/worker.js" }] });
    assert.equal(res.isError, true);
    assert.match(res.payload.message, /Module file not found/);
    assert.equal(cf.calls.length, 0, "no Cloudflare call made");
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("deploy_worker deletes the Worker it just created when the version upload fails", async () => {
  const cf = fakeCloudflare({
    [`GET /workers/${NAME}`]: notFound,
    "POST /workers": { result: worker() },
    [`POST /workers/${NAME}/versions?deploy=true`]: { error: { code: 10021, message: "Uncaught SyntaxError" } },
    [`DELETE /workers/${NAME}?force=true`]: { result: null },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", { script_name: NAME, ...code });
    assert.equal(res.isError, true);
    assert.equal(res.payload.code, "CF_10021");
    assert.ok(cf.calls.some((c) => c.method === "DELETE"), "orphan removed");
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("deploy_worker reports a failed observability PATCH as 'deployed, but…'", async () => {
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`POST /workers/${NAME}/versions?deploy=true`]: { result: { id: "v-2", number: 2 } },
    [`PATCH /workers/${NAME}`]: { error: { code: 10000, message: "boom" } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", { script_name: NAME, ...code, enable_observability: true });
    assert.equal(res.isError, true);
    assert.match(res.payload.message, /Version v-2 of cf-mcp-unit is deployed, but updating observability failed/);
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("update_worker_settings reports a failed logpush PATCH against the live version", async () => {
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`PATCH /workers/${NAME}`]: { error: { code: 10000, message: "boom" } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("update_worker_settings", { script_name: NAME, logpush: true });
    assert.equal(res.isError, true);
    assert.match(res.payload.message, /Version v-1 of cf-mcp-unit is deployed, but updating logpush failed/);
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("keep_assets refuses while a staged version is newer than the live one", async () => {
  const cf = fakeCloudflare({
    ...existingRoutes(),
    [`GET /workers/${NAME}/versions/latest`]: { result: { id: "v-9", number: 9 } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_worker", { script_name: NAME, ...code, keep_assets: true });
    assert.equal(res.isError, true);
    assert.match(res.payload.message, /staged, not live/);
    assert.ok(!cf.calls.some((c) => c.method !== "GET"), "nothing written");
  } finally {
    await mcp.close();
    cf.restore();
  }
});

test("enable_workers_dev:false on an existing served Worker reports no URL or note", async () => {
  const dir = await siteDir();
  const cf = fakeCloudflare({
    ...existingRoutes([]),
    [`POST /scripts/${NAME}/assets-upload-session`]: { result: { jwt: "session-jwt", buckets: [] } },
    [`POST /workers/${NAME}/versions?deploy=true`]: { result: { id: "v-2", number: 2 } },
  });
  const mcp = await connect();
  try {
    const res = await mcp.call("deploy_static_site", { script_name: NAME, directory: dir, enable_workers_dev: false });
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload.data.url, undefined);
    assert.equal(res.payload.data.note, undefined);
    assert.equal(res.payload.data.secrets_dropped, undefined);
  } finally {
    await mcp.close();
    cf.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
