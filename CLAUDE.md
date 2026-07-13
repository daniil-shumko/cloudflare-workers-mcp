# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an MCP (Model Context Protocol) server for managing Cloudflare Workers:
deploying static sites and Worker scripts, and managing versions, deployments,
custom domains, and cron triggers. It connects via stdio transport for use with
Claude Desktop and Claude Code.

**Project status: feature-complete v1.** All six milestones (M1–M6) are
implemented — 22 tools covering static-site deploys (the headline feature),
script lifecycle, versions/deployments/rollback, domains/subdomain/cron, and
log queries. **Read `IMPLEMENTATION_PLAN.md` before changing API-facing
code** — it carries verified API endpoint documentation (including the
static-asset direct-upload protocol) and the design gotchas; all endpoint
facts were re-verified against live Cloudflare docs on 2026-07-13.

This repo is the successor to
[cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp)
(local: `~/workspace/personal/cloudflare-pages-mcp`, now in maintenance mode).
The architecture deliberately mirrors it — when in doubt about a pattern
(summarizers, error suggestions, live-test guarding), the pages repo is the
worked example with 21 tools.

## Commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript to dist/)
npm run build

# Development mode with watch
npm run dev

# Type checking only (no emit)
npm run typecheck

# Run the server
npm start

# Tests (Node's built-in test runner via tsx — no extra framework)
npm test               # unit + protocol smoke (safe, no creds, CI-ready)
npm run test:unit      # pure-logic units, fully mocked fetch
npm run test:protocol  # builds, then drives the real server over the MCP stdio wire
npm run test:live      # guarded live e2e: deploys/serves/deletes a throwaway cf-mcp-test-* site
npm run typecheck:test # type-check the test files too (tsconfig.test.json)
```

See `test/README.md` for the test layering.

## Environment Variables

Required for running the server:
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token with Workers Scripts Edit permission (the "Edit Cloudflare Workers" template works)
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

## Architecture

```
src/
├── index.ts           # MCP server entry, tool definitions & handlers
├── workers/
│   ├── client.ts      # Cloudflare Workers API HTTP client (WorkersClient)
│   ├── assets.ts      # Manifest hashing + asset upload-session/bucket flow
│   ├── summarize.ts   # Pure response summarizers
│   └── types.ts       # TypeScript types for API requests/responses
└── utils/
    ├── config.ts        # Environment variable loader
    ├── errors.ts        # Error formatting for MCP responses
    └── rate-limiter.ts  # Token-bucket rate limiter for API calls
```

### Key Patterns

**Tool Structure**: All MCP tools are registered in `src/index.ts` via the
high-level `McpServer` + `registerTool` API. Each tool has a single source of
truth — one Zod schema — wired up through the local `addTool(name, config, handler)`
helper, which:
- passes the Zod schema to `registerTool` (the SDK generates the advertised
  JSON Schema and auto-validates inputs before the handler runs — no manual
  `.parse`, no hand-written JSON Schema copy)
- types the handler args via `z.infer`
- wraps the handler in a try/catch that formats thrown errors with `formatError`

Every tool carries `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`).

**API Client**: `WorkersClient` class (`src/workers/client.ts`) wraps all Cloudflare API calls with:
- Bearer token authentication
- Automatic error wrapping via `CloudflareAPIError`
- Typed responses using `CloudflareResponse<T>`
- `FormData` bodies pass through as multipart (needed for script uploads);
  everything else is JSON

**Response Formatting**: Tools return summarized responses using helper functions:
- `summarizeWorker()`, `summarizeVersion()`, `summarizeDeployment()`,
  `summarizeDomain()`, `summarizeLogEvent()` - reduce full API responses
- `formatSuccess()`, `formatError()` - consistent MCP output structure; results
  carry both a JSON text block and `structuredContent`

**Protocol test discipline**: `test/protocol/smoke.test.ts` pins the exact
advertised tool list — update `EXPECTED_TOOLS` in the same change that adds or
renames a tool.

## API Reference

Base URL: `https://api.cloudflare.com/client/v4/accounts/{account_id}/workers`

This server uses the **legacy Scripts API** (stable, full coverage), not the
beta Workers API — the rationale, all endpoint documentation, the asset-upload
protocol, and the milestone plan live in `IMPLEMENTATION_PLAN.md`.

## Toolchain constraints (do not "fix" these)

- **No `--dts` in the build**: TypeScript 7's Go compiler has no programmatic
  API until 7.1, so tsup's dts step crashes. This is a bin-only package; it
  ships no declarations on purpose.
- **`@modelcontextprotocol/sdk` must stay ≥ 1.29.0** (security patches). SDK
  v2 (new package names, ~2026-07-28) is a planned migration for late 2026 —
  don't do it ad hoc.
- **`@types/node` stays ^22** to match `engines.node >=22`; bumping it would
  let Node-26-only APIs slip past typecheck and crash on supported LTS.
