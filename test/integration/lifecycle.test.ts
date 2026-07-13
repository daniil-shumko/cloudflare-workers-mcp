import { test } from "node:test";

/**
 * Guarded live e2e against a real Cloudflare account — to be implemented
 * alongside the deploy tools (see IMPLEMENTATION_PLAN.md, milestone M2):
 * deploy a throwaway static site → verify it serves → clean up, with
 * always-on cleanup mirroring cloudflare-pages-mcp's lifecycle test.
 *
 * Until then this placeholder keeps `npm run test:live` runnable. When
 * implementing, gate on CF_LIVE_TEST=1 + CLOUDFLARE_API_TOKEN +
 * CLOUDFLARE_ACCOUNT_ID and report `skipped` when any is missing.
 */
test("live Workers lifecycle (not yet implemented)", { skip: true }, () => {
  // Intentionally empty — see IMPLEMENTATION_PLAN.md M2.
});
