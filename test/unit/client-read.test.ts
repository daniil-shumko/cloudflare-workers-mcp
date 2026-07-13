/**
 * Unit tests for the M1 read-only client methods: code download, versions,
 * deployments, cron triggers, domains, and subdomain getters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkersClient, CloudflareAPIError } from "../../src/workers/client.js";
import { installMockFetch, cfOk, cfErr } from "../helpers/mock-fetch.js";

const ACCOUNT = "acct-123";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function makeClient(): WorkersClient {
  return new WorkersClient("test-token", ACCOUNT);
}

test("downloadWorkerCode returns a single module for a plain-script response", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue({
      status: 200,
      headers: { "Content-Type": "application/javascript" },
      text: "addEventListener('fetch', () => {})",
    });

    const client = makeClient();
    const { contentType, modules } = await client.downloadWorkerCode("my-worker");

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker`);
    assert.equal(contentType, "application/javascript");
    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, "my-worker");
    assert.match(modules[0].content, /addEventListener/);
  } finally {
    mock.restore();
  }
});

test("downloadWorkerCode parses a multipart module response into one module per part", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue({
      status: 200,
      headers: { "Content-Type": "multipart/form-data; boundary=x" },
      form: [
        { name: "index.js", content: "export default {}", type: "application/javascript+module", filename: "index.js" },
        { name: "lib.js", content: "export const a = 1", type: "application/javascript+module", filename: "lib.js" },
      ],
    });

    const client = makeClient();
    const { modules } = await client.downloadWorkerCode("mod-worker");

    assert.equal(modules.length, 2);
    assert.deepEqual(
      modules.map((m) => m.name).sort(),
      ["index.js", "lib.js"]
    );
    const index = modules.find((m) => m.name === "index.js");
    assert.equal(index?.content, "export default {}");
    assert.equal(index?.content_type, "application/javascript+module");
  } finally {
    mock.restore();
  }
});

test("downloadWorkerCode handles filename-less multipart parts as string entries (undici behavior)", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue({
      status: 200,
      headers: { "Content-Type": "multipart/form-data; boundary=x" },
      form: [{ name: "index.js", content: "export default {}" }],
    });

    const client = makeClient();
    const { modules } = await client.downloadWorkerCode("mod-worker");

    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, "index.js");
    assert.equal(modules[0].content, "export default {}");
    // undici drops the part content type for filename-less parts.
    assert.equal(modules[0].content_type, undefined);
  } finally {
    mock.restore();
  }
});

test("downloadWorkerCode surfaces the JSON error envelope on failure", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfErr(404, 10007, "workers.api.error.script_not_found"));

    const client = makeClient();
    await assert.rejects(
      () => client.downloadWorkerCode("nope"),
      (err: unknown) => {
        assert.ok(err instanceof CloudflareAPIError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.errors[0].code, 10007);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

test("listVersions and listDeployments target the versions/deployments endpoints", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ items: [{ id: "v1", number: 1 }] }));
    mock.enqueue(cfOk({ deployments: [{ id: "d1", strategy: "percentage" }] }));

    const client = makeClient();
    const versions = await client.listVersions("my worker");
    const deployments = await client.listDeployments("my worker");

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my%20worker/versions`);
    assert.equal(mock.calls[1].url, `${BASE}/workers/scripts/my%20worker/deployments`);
    assert.deepEqual(versions.result, { items: [{ id: "v1", number: 1 }] });
    assert.equal(deployments.result.deployments?.[0].id, "d1");
  } finally {
    mock.restore();
  }
});

test("getCronTriggers targets /schedules and parses the schedules wrapper", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ schedules: [{ cron: "*/30 * * * *" }] }));

    const client = makeClient();
    const response = await client.getCronTriggers("cron-worker");

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/cron-worker/schedules`);
    assert.equal(response.result.schedules?.[0].cron, "*/30 * * * *");
  } finally {
    mock.restore();
  }
});

test("listDomains passes only the provided filters as query params", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk([{ id: "dom-1", hostname: "app.example.com", service: "my-worker" }]));

    const client = makeClient();
    const response = await client.listDomains({ service: "my-worker", hostname: undefined });

    const url = new URL(mock.calls[0].url);
    assert.equal(url.pathname, `/client/v4/accounts/${ACCOUNT}/workers/domains`);
    assert.equal(url.searchParams.get("service"), "my-worker");
    assert.equal(url.searchParams.has("hostname"), false);
    assert.equal(response.result[0].hostname, "app.example.com");
  } finally {
    mock.restore();
  }
});

test("queryTelemetry POSTs the query body to the telemetry endpoint", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ events: { count: 1, events: [{ timestamp: 1752364800000 }] } }));

    const client = makeClient();
    const response = await client.queryTelemetry({
      queryId: "workers-mcp-logs",
      timeframe: { from: 1752361200000, to: 1752364800000 },
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "my-worker" }],
        calculations: [],
        groupBys: [],
      },
      view: "events",
      limit: 20,
      dry: true,
    });

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/observability/telemetry/query`);
    const body = JSON.parse(mock.calls[0].body as string) as {
      timeframe: { from: number; to: number };
      parameters: { filters: Array<{ value: string }> };
      dry: boolean;
    };
    assert.equal(body.timeframe.from, 1752361200000);
    assert.equal(body.parameters.filters[0].value, "my-worker");
    assert.equal(body.dry, true);
    assert.equal(response.result.events?.count, 1);
  } finally {
    mock.restore();
  }
});

test("subdomain getters target the script and account subdomain endpoints", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ enabled: true, previews_enabled: false }));
    mock.enqueue(cfOk({ subdomain: "my-team" }));

    const client = makeClient();
    const script = await client.getScriptSubdomain("my-worker");
    const account = await client.getAccountSubdomain();

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/subdomain`);
    assert.equal(mock.calls[1].url, `${BASE}/workers/subdomain`);
    assert.equal(script.result.enabled, true);
    assert.equal(account.result.subdomain, "my-team");
  } finally {
    mock.restore();
  }
});
