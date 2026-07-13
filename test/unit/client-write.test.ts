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

test("uploadScript PUTs FormData through without forcing a JSON content type", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "my-worker", etag: "etag-1" }));

    const form = new FormData();
    form.append(
      "metadata",
      new File([JSON.stringify({ main_module: "index.js" })], "metadata.json", {
        type: "application/json",
      })
    );
    form.append(
      "index.js",
      new File(["export default {}"], "index.js", { type: "application/javascript+module" })
    );

    const client = makeClient();
    const response = await client.uploadScript("my worker", form);

    assert.equal(mock.calls[0].method, "PUT");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my%20worker`);
    // fetch must set the multipart boundary itself.
    assert.equal("Content-Type" in mock.calls[0].headers, false);
    assert.ok(mock.calls[0].body instanceof FormData);
    assert.equal(response.result.etag, "etag-1");
  } finally {
    mock.restore();
  }
});

test("patchWorkerSettings sends multipart with a single settings JSON part", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ compatibility_date: "2026-07-01" }));

    const client = makeClient();
    await client.patchWorkerSettings("my-worker", { compatibility_date: "2026-07-01" });

    assert.equal(mock.calls[0].method, "PATCH");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/settings`);
    assert.ok(mock.calls[0].body instanceof FormData);
    const form = mock.calls[0].body as FormData;
    const part = form.get("settings");
    assert.ok(part instanceof File);
    assert.deepEqual(JSON.parse(await part.text()), { compatibility_date: "2026-07-01" });
    // Exactly one part: the settings JSON.
    assert.deepEqual([...form.keys()], ["settings"]);
  } finally {
    mock.restore();
  }
});

test("deleteWorker targets the script endpoint and only sends force when set", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk(null));
    mock.enqueue(cfOk(null));

    const client = makeClient();
    await client.deleteWorker("doomed");
    await client.deleteWorker("doomed", true);

    assert.equal(mock.calls[0].method, "DELETE");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/doomed`);
    assert.equal(mock.calls[1].url, `${BASE}/workers/scripts/doomed?force=true`);
  } finally {
    mock.restore();
  }
});

test("createVersion POSTs multipart to /versions", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "v-new", number: 4 }));

    const form = new FormData();
    form.append(
      "metadata",
      new File([JSON.stringify({ main_module: "index.js" })], "metadata.json", {
        type: "application/json",
      })
    );

    const client = makeClient();
    const response = await client.createVersion("my-worker", form);

    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/versions`);
    assert.ok(mock.calls[0].body instanceof FormData);
    assert.equal(response.result.number, 4);
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

test("getVersion targets the version-detail endpoint", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ id: "v-1", number: 1, resources: { bindings: [] } }));

    const client = makeClient();
    const response = await client.getVersion("my-worker", "v-1");

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/versions/v-1`);
    assert.deepEqual(response.result.resources, { bindings: [] });
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

test("setScriptSubdomain POSTs enabled (and previews only when specified)", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ enabled: true }));
    mock.enqueue(cfOk({ enabled: true, previews_enabled: true }));

    const client = makeClient();
    await client.setScriptSubdomain("my-worker", true);
    await client.setScriptSubdomain("my-worker", true, true);

    assert.equal(mock.calls[0].url, `${BASE}/workers/scripts/my-worker/subdomain`);
    assert.deepEqual(JSON.parse(mock.calls[0].body as string), { enabled: true });
    assert.deepEqual(JSON.parse(mock.calls[1].body as string), {
      enabled: true,
      previews_enabled: true,
    });
  } finally {
    mock.restore();
  }
});
