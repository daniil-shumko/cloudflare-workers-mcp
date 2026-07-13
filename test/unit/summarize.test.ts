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
  WorkerScript,
  WorkerVersion,
} from "../../src/workers/types.js";

test("summarizeWorker maps id to name and keeps the agent-relevant fields", () => {
  const script: WorkerScript = {
    id: "my-site",
    etag: "abc123",
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-02-01T00:00:00Z",
    has_assets: true,
    has_modules: false,
    usage_model: "standard",
    placement_mode: "smart",
    logpush: false,
    routes: [{ pattern: "example.com/*" }],
  };

  const summary = summarizeWorker(script);

  assert.deepEqual(summary, {
    name: "my-site",
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-02-01T00:00:00Z",
    has_assets: true,
    has_modules: false,
    usage_model: "standard",
    placement_mode: "smart",
    logpush: false,
  });
  // Noise like etag/routes must not leak into the summary.
  assert.equal("etag" in summary, false);
  assert.equal("routes" in summary, false);
});

test("summarizeWorker tolerates a minimal script object", () => {
  const summary = summarizeWorker({ id: "bare" });
  assert.equal(summary.name, "bare");
  assert.equal(summary.has_assets, undefined);
});

test("summarizeVersion pulls the agent-relevant fields out of metadata", () => {
  const version: WorkerVersion = {
    id: "v-uuid-1",
    number: 3,
    metadata: {
      author_email: "dev@example.com",
      author_id: "auth-noise",
      created_on: "2026-03-01T00:00:00Z",
      modified_on: "2026-03-01T00:00:00Z",
      hasPreview: true,
      source: "api",
    },
    resources: { script: { etag: "noise" } },
  };

  const summary = summarizeVersion(version);

  assert.deepEqual(summary, {
    id: "v-uuid-1",
    number: 3,
    created_on: "2026-03-01T00:00:00Z",
    author: "dev@example.com",
    source: "api",
  });
  assert.equal("resources" in summary, false);
});

test("summarizeVersion tolerates missing metadata", () => {
  const summary = summarizeVersion({ id: "v-bare" });
  assert.equal(summary.id, "v-bare");
  assert.equal(summary.author, undefined);
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
