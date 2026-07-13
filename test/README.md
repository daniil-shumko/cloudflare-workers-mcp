# Tests

The suite uses Node's built-in test runner (`node:test` + `node:assert/strict`)
run through [`tsx`](https://github.com/privatenumber/tsx) — no extra test
framework. TypeScript runs directly; source is imported with `.js` specifiers
(e.g. `../../src/workers/client.js`) that resolve to the `.ts` files.

## Layers

| Path | Layer | Hits the network? | Needs creds? |
| --- | --- | --- | --- |
| `test/unit/**` | Pure logic — summarizers, error formatting, rate limiter, config, and the `WorkersClient` HTTP layer with a mocked `fetch` | No | No |
| `test/protocol/**` | End-to-end MCP protocol over stdio: all tools advertised, input-schema validation, error/result shape. Spawns the real server with **dummy** creds | No* | No |
| `test/integration/**` | **Guarded** live lifecycle against a **real** Cloudflare account: deploy a throwaway static site, verify it serves over HTTP, exercise dedupe, delete it | Yes | Yes |

\* The protocol test uses a dummy token, so the tool calls it makes fail
closed whether or not a network is present — the assertions hold either way.

## Commands

```bash
npm test              # unit + protocol (safe, no creds, CI-ready)
npm run test:unit     # unit only (fast, fully mocked)
npm run test:protocol # builds, then runs the stdio protocol smoke test
npm run typecheck:test # type-check the test files (and src) under tsconfig.test.json
```

## The live integration test

Follows the cloudflare-pages-mcp pattern: **skipped by default**, only runs
with `CF_LIVE_TEST=1` + real creds, creates a throwaway `cf-mcp-test-*` Worker
(a tiny static site deployed through the real MCP server over stdio, then
fetched over HTTP), and always cleans up — even when an assertion fails. It is
also the canonical confirmation that an assets-only Worker (metadata without
`main_module`) deploys, which the docs never state outright.

```bash
CLOUDFLARE_API_TOKEN=<token-with-Workers-Scripts:Edit> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
npm run test:live          # test:live sets CF_LIVE_TEST=1 for you
```

## Adding a unit test

Copy `test/unit/summarize.test.ts` for the style. For anything that calls the
Cloudflare API, use the shared mock in `test/helpers/mock-fetch.ts`:

```ts
import { installMockFetch, cfOk, cfErr } from "../helpers/mock-fetch.js";

const mock = installMockFetch();
try {
  mock.enqueue(cfOk([{ id: "my-worker" /* ... */ }]));
  // ... exercise the client, then assert on mock.calls[0] and the result
} finally {
  mock.restore();
}
```
