/**
 * Unit tests for the client methods behind the secrets, live-tail and
 * Worker Previews tools (paths, methods and body shapes, all mocked).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkersClient } from "../../src/workers/client.js";
import { installMockFetch, cfOk } from "../helpers/mock-fetch.js";

const ACCOUNT = "acct-123";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function makeClient(): WorkersClient {
  return new WorkersClient("test-token", ACCOUNT);
}

test("patchSecrets sends a merge patch: strings become secret_text, null deletes", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ API_KEY: { name: "API_KEY", type: "secret_text" } }));
    await makeClient().patchSecrets("my-worker", { API_KEY: "s3cr3t", OLD: null });

    assert.equal(mock.calls[0].method, "PATCH");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/secrets-bulk`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), {
      secrets: { API_KEY: { type: "secret_text", text: "s3cr3t" }, OLD: null },
    });
  } finally {
    mock.restore();
  }
});

test("listSecrets and deleteSecret target the per-script secrets endpoints", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk([{ name: "A", type: "secret_text" }]));
    mock.enqueue(cfOk(null));
    const client = makeClient();
    const list = await client.listSecrets("w");
    await client.deleteSecret("w", "MY/SECRET");

    assert.equal(mock.calls[0].method, "GET");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/w/secrets`);
    assert.deepEqual(list.result, [{ name: "A", type: "secret_text" }]);
    assert.equal(mock.calls[1].method, "DELETE");
    assert.equal(mock.calls[1].url, `${BASE}/workers/scripts/w/secrets/MY%2FSECRET`);
  } finally {
    mock.restore();
  }
});

test("createTail POSTs and deleteTail DELETEs the script tails endpoints", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "t1", url: "wss://tail.example/x", expires_at: "2026-11-05T00:00:00Z" }));
    mock.enqueue(cfOk(null));
    const client = makeClient();
    const tail = await client.createTail("w");
    await client.deleteTail("w", "t1");

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/w/tails`);
    assert.equal(tail.result.url, "wss://tail.example/x");
    assert.equal(mock.calls[1].method, "DELETE");
    assert.equal(mock.calls[1].url, `${BASE}/workers/scripts/w/tails/t1`);
  } finally {
    mock.restore();
  }
});

test("preview methods use the new Workers API path keyed by Worker name", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk([]));
    mock.enqueue(cfOk({ id: "p1", name: "feat", slug: "feat", urls: [] }));
    mock.enqueue(cfOk({ id: "d1", urls: ["https://d1-w.acct.workers.dev"] }));
    mock.enqueue(cfOk(null));
    const client = makeClient();
    await client.listPreviews("w", { per_page: 100 });
    await client.createPreview("w", "feat");
    await client.createPreviewDeployment("w", "p1", {
      main_module: "index.js",
      modules: [{ name: "index.js", content_type: "application/javascript+module", content_base64: "eA==" }],
    });
    await client.deletePreview("w", "p1");

    assert.equal(mock.calls[0].method, "GET");
    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/w/previews?per_page=100`);
    assert.equal(mock.calls[1].method, "POST");
    assert.deepEqual(JSON.parse(mock.calls[1].body as string), { name: "feat" });
    assert.equal(mock.calls[2].url, `${BASE}/workers/workers/w/previews/p1/deployments`);
    assert.equal(JSON.parse(mock.calls[2].body as string).modules[0].content_base64, "eA==");
    assert.equal(mock.calls[3].method, "DELETE");
    assert.equal(mock.calls[3].url, `${BASE}/workers/workers/w/previews/p1`);
  } finally {
    mock.restore();
  }
});
