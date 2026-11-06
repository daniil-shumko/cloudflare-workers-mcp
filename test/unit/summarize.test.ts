import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeDeployment,
  summarizeDomain,
  summarizeLogEvent,
  summarizeVersion,
  summarizeWorker,
} from "../../src/workers/summarize.js";
import type {
  TelemetryEvent,
  WorkerDeployment,
  WorkerDomain,
  WorkerInfo,
  WorkerVersion,
} from "../../src/workers/types.js";

test("summarizeWorker keeps the agent-relevant fields of a Workers-API Worker", () => {
  const worker: WorkerInfo = {
    id: "uuid-noise",
    name: "my-site",
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-02-01T00:00:00Z",
    deployed_on: "2026-02-01T00:00:00Z",
    logpush: false,
    observability: { enabled: true, head_sampling_rate: 1 },
    subdomain: { enabled: true, url: "https://my-site.acct.workers.dev" },
    tags: ["noise"],
  };

  const summary = summarizeWorker(worker);

  assert.deepEqual(summary, {
    name: "my-site",
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-02-01T00:00:00Z",
    deployed_on: "2026-02-01T00:00:00Z",
    logpush: false,
    workers_dev: true,
    observability: true,
  });
  // Noise like the UUID and tags must not leak into the summary.
  assert.equal("id" in summary, false);
  assert.equal("tags" in summary, false);
});

test("summarizeWorker tolerates a minimal Worker object", () => {
  const summary = summarizeWorker({ id: "uuid", name: "bare" });
  assert.equal(summary.name, "bare");
  assert.equal(summary.workers_dev, undefined);
});

test("summarizeVersion keeps the agent-relevant fields including the deploy message", () => {
  const version: WorkerVersion = {
    id: "v-uuid-1",
    number: 3,
    created_on: "2026-03-01T00:00:00Z",
    author_email: "dev@example.com",
    author_id: "auth-noise",
    source: "api",
    annotations: { "workers/message": "fix login", "workers/tag": "v3" },
    bindings: [{ type: "plain_text", name: "NOISE", text: "x" }],
  };

  const summary = summarizeVersion(version);

  assert.deepEqual(summary, {
    id: "v-uuid-1",
    number: 3,
    created_on: "2026-03-01T00:00:00Z",
    author: "dev@example.com",
    source: "api",
    message: "fix login",
    tag: "v3",
  });
  assert.equal("bindings" in summary, false);
});

test("summarizeVersion tolerates a bare version", () => {
  assert.deepEqual(summarizeVersion({ id: "v-bare" }), { id: "v-bare" });
});

test("summarizeDeployment keeps the version split and drops noise", () => {
  const deployment: WorkerDeployment = {
    id: "d-uuid-1",
    source: "api",
    strategy: "percentage",
    author_email: "dev@example.com",
    created_on: "2026-03-02T00:00:00Z",
    annotations: { "workers/message": "gradual rollout" },
    versions: [
      { version_id: "v-old", percentage: 90 },
      { version_id: "v-new", percentage: 10 },
    ],
  };

  const summary = summarizeDeployment(deployment);

  assert.equal(summary.id, "d-uuid-1");
  assert.equal(summary.strategy, "percentage");
  assert.equal(summary.message, "gradual rollout");
  assert.deepEqual(summary.versions, [
    { version_id: "v-old", percentage: 90 },
    { version_id: "v-new", percentage: 10 },
  ]);
});

test("summarizeLogEvent flattens a fetch event and drops undefined fields", () => {
  const event: TelemetryEvent = {
    dataset: "cloudflare-workers",
    timestamp: 1752364800000,
    $metadata: {
      id: "cursor-noise",
      message: "handled request",
      level: "log",
      service: "my-worker",
    },
    $workers: {
      scriptName: "my-worker",
      outcome: "ok",
      eventType: "fetch",
      event: {
        request: { method: "GET", path: "/api/users", url: "https://x.example/api/users" },
        response: { status: 200 },
      },
      cpuTimeMs: 3,
      wallTimeMs: 12,
    },
  };

  const summary = summarizeLogEvent(event);

  assert.deepEqual(summary, {
    timestamp: "2025-07-13T00:00:00.000Z",
    level: "log",
    message: "handled request",
    outcome: "ok",
    event_type: "fetch",
    request: "GET /api/users",
    status: 200,
    cpu_ms: 3,
    wall_ms: 12,
  });
  assert.equal("error" in summary, false, "undefined fields must be dropped");
});

test("summarizeLogEvent falls back to the trigger for non-fetch events and tolerates bare events", () => {
  const cron = summarizeLogEvent({
    timestamp: 1752364800000,
    $metadata: { trigger: "*/30 * * * *", error: "boom" },
    $workers: { eventType: "scheduled", outcome: "exception" },
  });
  assert.equal(cron.request, "*/30 * * * *");
  assert.equal(cron.error, "boom");

  const bare = summarizeLogEvent({});
  assert.deepEqual(bare, {});
});

test("summarizeDomain keeps the attachment fields", () => {
  const domain: WorkerDomain = {
    id: "dom-1",
    zone_id: "z-noise",
    zone_name: "example.com",
    hostname: "app.example.com",
    service: "my-worker",
    environment: "production",
  };

  const summary = summarizeDomain(domain);

  assert.deepEqual(summary, {
    id: "dom-1",
    hostname: "app.example.com",
    zone_name: "example.com",
    service: "my-worker",
    environment: "production",
  });
});
