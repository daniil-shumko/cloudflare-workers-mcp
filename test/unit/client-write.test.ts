/**
 * Unit tests for the write-side client methods: script upload (multipart
 * passthrough), settings PATCH (single settings part), delete, and the
 * per-script subdomain setter.
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

test("createVersion POSTs a JSON version body and only sends deploy=true when deploying", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "v-1", number: 1 }));
    mock.enqueue(cfOk({ id: "v-2", number: 2 }));

    const client = makeClient();
    const body = {
      main_module: "index.js",
      compatibility_date: "2026-11-05",
      modules: [{ name: "index.js", content_type: "application/javascript+module", content_base64: "eA==" }],
    };
    await client.createVersion("my worker", body, true);
    await client.createVersion("my worker", body, false);

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/my%20worker/versions?deploy=true`);
    assert.equal(mock.calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), body);
    assert.equal(mock.calls[1].url, `${BASE}/workers/workers/my%20worker/versions`);
  } finally {
    mock.restore();
  }
});

test("patchLatestVersion merge-patches /versions/latest and getLatestVersion reads it", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "v-3" }));
    mock.enqueue(cfOk({ id: "v-3" }));

    const client = makeClient();
    await client.patchLatestVersion("w", { compatibility_date: "2026-11-05" }, true);
    const latest = await client.getLatestVersion("w");

    assert.equal(mock.calls[0].method, "PATCH");
    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/w/versions/latest?deploy=true`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), { compatibility_date: "2026-11-05" });
    assert.equal(mock.calls[1].method, "GET");
    assert.equal(mock.calls[1].url, `${BASE}/workers/workers/w/versions/latest`);
    assert.equal(latest.result.id, "v-3");
  } finally {
    mock.restore();
  }
});

test("createWorker POSTs the name plus settings; patchWorker PATCHes Worker-level fields", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "uuid", name: "new-site" }));
    mock.enqueue(cfOk({ id: "uuid", name: "new-site" }));

    const client = makeClient();
    await client.createWorker("new-site", { subdomain: { enabled: true } });
    await client.patchWorker("new-site", { observability: { enabled: true }, logpush: false });

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/workers`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), {
      name: "new-site",
      subdomain: { enabled: true },
    });
    assert.equal(mock.calls[1].method, "PATCH");
    assert.equal(mock.calls[1].url, `${BASE}/workers/workers/new-site`);
    assert.deepEqual(JSON.parse(mock.calls[1].body as string), {
      observability: { enabled: true },
      logpush: false,
    });
  } finally {
    mock.restore();
  }
});

test("deleteWorker targets the Workers API endpoint and only sends force when set", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk(null));
    mock.enqueue(cfOk(null));

    const client = makeClient();
    await client.deleteWorker("doomed");
    await client.deleteWorker("doomed", true);

    assert.equal(mock.calls[0].method, "DELETE");
    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/doomed`);
    assert.equal(mock.calls[1].url, `${BASE}/workers/workers/doomed?force=true`);
  } finally {
    mock.restore();
  }
});

test("listVersions asks for one page of up to 100 versions", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk([{ id: "v-2", number: 2 }, { id: "v-1", number: 1 }]));

    const response = await makeClient().listVersions("w");

    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/w/versions?per_page=100`);
    assert.equal(response.result.length, 2);
  } finally {
    mock.restore();
  }
});

test("createDeployment POSTs the percentage strategy and only sends force when set", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "d-1", strategy: "percentage", versions: [{ version_id: "v-old", percentage: 100 }] }));
    mock.enqueue(cfOk({ id: "d-2", strategy: "percentage", versions: [] }));

    const client = makeClient();
    await client.createDeployment("my-worker", {
      strategy: "percentage",
      versions: [{ version_id: "v-old", percentage: 100 }],
      annotations: { "workers/message": "rollback" },
    });
    await client.createDeployment(
      "my-worker",
      { strategy: "percentage", versions: [{ version_id: "v-new", percentage: 100 }] },
      true
    );

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/deployments`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), {
      strategy: "percentage",
      versions: [{ version_id: "v-old", percentage: 100 }],
      annotations: { "workers/message": "rollback" },
    });
    assert.equal(mock.calls[1].url, `${BASE}/workers/scripts/my-worker/deployments?force=true`);
  } finally {
    mock.restore();
  }
});

test("getVersion targets the version-detail endpoint and only includes modules on request", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "v-1", number: 1, bindings: [] }));
    mock.enqueue(cfOk({ id: "v-1", modules: [{ name: "index.js", content_type: "x", content_base64: "eA==" }] }));

    const client = makeClient();
    const meta = await client.getVersion("my-worker", "v-1");
    const withCode = await client.getVersion("my-worker", "v-1", true);

    assert.equal(mock.calls[0].url, `${BASE}/workers/workers/my-worker/versions/v-1`);
    assert.deepEqual(meta.result.bindings, []);
    assert.equal(mock.calls[1].url, `${BASE}/workers/workers/my-worker/versions/v-1?include=modules`);
    assert.equal(withCode.result.modules?.[0].name, "index.js");
  } finally {
    mock.restore();
  }
});

test("setCronTriggers PUTs a bare JSON array and parses the schedules wrapper", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ schedules: [{ cron: "*/30 * * * *" }] }));

    const client = makeClient();
    const response = await client.setCronTriggers("cron-worker", ["*/30 * * * *"]);

    assert.equal(mock.calls[0].method, "PUT");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/cron-worker/schedules`);
    // The request body must be the bare array — the {schedules} wrapper is response-only.
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), [{ cron: "*/30 * * * *" }]);
    assert.equal(response.result.schedules?.[0].cron, "*/30 * * * *");
  } finally {
    mock.restore();
  }
});

test("attachDomain PUTs to /workers/domains and detachDomain DELETEs by ID", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "dom-1", hostname: "app.example.com", service: "my-worker" }));
    mock.enqueue(cfOk(null));

    const client = makeClient();
    await client.attachDomain({ hostname: "app.example.com", service: "my-worker" });
    await client.detachDomain("dom-1");

    assert.equal(mock.calls[0].method, "PUT");
    assert.equal(mock.calls[0].url, `${BASE}/workers/domains`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), {
      hostname: "app.example.com",
      service: "my-worker",
    });
    assert.equal(mock.calls[1].method, "DELETE");
    assert.equal(mock.calls[1].url, `${BASE}/workers/domains/dom-1`);
  } finally {
    mock.restore();
  }
});
