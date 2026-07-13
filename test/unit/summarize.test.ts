import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeWorker } from "../../src/workers/summarize.js";
import type { WorkerScript } from "../../src/workers/types.js";

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
