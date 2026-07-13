# Cloudflare Workers MCP Server

[![npm version](https://img.shields.io/npm/v/cloudflare-workers-mcp.svg)](https://www.npmjs.com/package/cloudflare-workers-mcp)
[![Tests](https://github.com/daniil-shumko/cloudflare-workers-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/daniil-shumko/cloudflare-workers-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

> ⚠️ **Security warning**: this server was substantially AI-written. Before
> pointing it at an account you care about: (1) review the code — it is small
> and readable, an audit takes ~30 minutes; (2) for maximum caution, clone and
> build from source rather than trusting the npm artifact (or at least pin an
> exact version); (3) give the API token the minimum permission
> (**Workers Scripts: Edit**) and nothing else; (4) prefer a test account for
> the first runs.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for
managing Cloudflare Workers from Claude Desktop or Claude Code — the successor
to [cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp),
following Cloudflare's own shift from Pages to
[Workers with static assets](https://developers.cloudflare.com/workers/static-assets/).

## Why

As of mid-2026, no other MCP server — including Cloudflare's official ones —
can deploy a Worker. Cloudflare's remote MCP servers are read-only for Workers
management, and their Code Mode server has no filesystem so it can't upload
real asset trees. A local stdio server can: the Workers static-asset upload
protocol is [publicly documented](https://developers.cloudflare.com/workers/static-assets/direct-upload/),
so this server's headline feature is:

> *"Deploy this directory as a static site on Cloudflare Workers"* — in one
> natural-language request, with free unlimited static-asset serving.

## Tools

### Static sites (the differentiator)
- **deploy_static_site** - Deploy a local directory as a static site: manifest hashing, server-side dedupe (unchanged files never re-upload), `_headers`/`_redirects` support, SPA/404 handling, live workers.dev URL in the result
- **redeploy_assets** - Redeploy reusing already-uploaded files (`keep_assets`) to change `html_handling`/`not_found_handling` without re-uploading

### Workers
- **list_workers** - List all Worker scripts in your account
- **get_worker** - Settings (bindings, compat date/flags, placement, observability) plus cron triggers and workers.dev status
- **get_worker_code** - Download a Worker's deployed source (all modules)
- **deploy_worker** - Upload and deploy ES-module Workers with bindings (`plain_text`, `secret_text`, `kv_namespace`, `r2_bucket`, `d1`, `assets`)
- **update_worker_settings** - Change bindings/compat/logpush/observability without re-uploading code
- **delete_worker** - Permanently delete a Worker (optional `force`)

### Versions & deployments
- **list_versions / get_version** - Immutable version history and per-version detail
- **create_version** - Staged upload that does NOT touch live traffic
- **list_deployments / create_deployment** - Map traffic to versions: single version at 100% or gradual splits (e.g. 90/10)
- **rollback_worker** - Deploy an older version back to 100% traffic

### Domains, routing, cron
- **list_worker_domains / add_worker_domain / delete_worker_domain** - Custom domains (zone must be active in your account)
- **set_workers_dev** - Enable/disable `<name>.<account>.workers.dev` serving and version preview URLs
- **get_cron_triggers / set_cron_triggers** - Read or replace a Worker's cron trigger set

### Observability
- **query_worker_logs** - Workers Logs with time window, error filter, and full-text search (requires observability enabled on the Worker)
- **health_check** - Verify API token and connection to Cloudflare

## Quick Start

Requires **Node.js 22+**.

**Option A: install from npm**
```bash
npm install -g cloudflare-workers-mcp
```

**Option B: clone and build locally (for code review)**
```bash
git clone https://github.com/daniil-shumko/cloudflare-workers-mcp
cd cloudflare-workers-mcp
npm install
npm run build
npm test        # unit + MCP protocol smoke, no creds needed
```

### Configure Claude Desktop/Code

Create an API token with **Workers Scripts: Edit** (the "Edit Cloudflare
Workers" template works; both user and account-owned tokens are fine), find
your account ID in the [dashboard](https://dash.cloudflare.com), then:

```json
{
  "mcpServers": {
    "cloudflare-workers": {
      "command": "npx",
      "args": ["cloudflare-workers-mcp"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your_token_here",
        "CLOUDFLARE_ACCOUNT_ID": "your_account_id_here"
      }
    }
  }
}
```

(If you built from source, use `"command": "node"` with
`"args": ["/absolute/path/to/cloudflare-workers-mcp/dist/index.js"]` instead.)

Or with the Claude Code CLI:

```bash
claude mcp add cloudflare-workers \
  -e CLOUDFLARE_API_TOKEN=your_token_here \
  -e CLOUDFLARE_ACCOUNT_ID=your_account_id_here \
  -- npx cloudflare-workers-mcp
```

## Usage Examples

```
Deploy the ./dist folder as a static site called my-blog
```

```
Deploy ./build as an SPA — client-side routing should fall back to index.html
```

```
Deploy this worker script with a KV binding for CACHE (namespace abc123)
```

```
Stage the new version without deploying, then roll it out 10% / 90%
```

```
Roll my-api back to the previous version
```

```
Attach app.example.com to my-api and add a cron trigger every 30 minutes
```

```
Show me the errors my-api logged in the last 2 hours
```

## Important Notes

### Static site deploys
- Unchanged files are **deduped server-side**: redeploying an identical
  directory uploads zero bytes and still creates a new version.
- A `_headers` or `_redirects` file at the directory root is applied as
  configuration ([syntax](https://developers.cloudflare.com/workers/static-assets/headers/)),
  not uploaded as a public asset. A root `.assetsignore` is applied with
  gitignore-style rules (globs, `!` negation, `dir/` and `/anchored`
  patterns; character classes unsupported) and the result reports how many
  files it excluded.
- Limits: 25 MiB per file; 20,000 files per version on free plans
  (100,000 on paid). Static-asset requests are free and unmetered.
- Symlinks inside the directory are followed; symlinks pointing outside it
  abort the deploy.

### Versions & rollouts
- `create_version` stages code; only `create_deployment` (or a direct
  deploy) shifts traffic. Gradual rollouts split across at most two
  versions and percentages must sum to 100.
- Rollbacks reach the 100 most recent versions and never revert data in
  bound resources (KV, R2, D1); a changed secret blocks rollback unless
  `force` is set.

### Domains & serving
- Custom domains require the zone to be **active in the same Cloudflare
  account** — external/partial zones are not supported (unlike Pages).
- Deploy tools enable workers.dev serving for **newly created** Workers so
  the result carries a working URL. Redeploys never change an existing
  Worker's workers.dev setting unless `enable_workers_dev` is passed
  explicitly — a deliberately disabled Worker stays private.
- When `compatibility_date` is omitted, deploys **preserve the existing
  Worker's pinned date** (new Workers get today's date) — a redeploy never
  silently activates newer runtime behavior.

### Cron & logs
- `set_cron_triggers` **replaces** the full trigger set; pass `[]` to clear.
- `query_worker_logs` needs the Worker uploaded with observability enabled
  (`deploy_worker`'s `enable_observability`, or `update_worker_settings`).
  Retention is 3 days (free) / 7 days (paid).

## Development

```bash
npm run build          # compile to dist/ (tsup, ESM)
npm run typecheck      # tsc --noEmit
npm test               # unit + protocol smoke — safe, no creds, CI-ready
npm run test:unit      # pure-logic units, fully mocked fetch
npm run test:protocol  # drives the built server over the MCP stdio wire
npm run test:live      # guarded live e2e (CF_LIVE_TEST=1 + real creds)
```

See [test/README.md](test/README.md) for the test layering. The live e2e
deploys a throwaway `cf-mcp-test-*` site through the real server, verifies it
serves over HTTP, and always cleans up.

## Related Links

- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) - Verified API reference, design decisions, milestone history
- [cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp) - The maintenance-mode predecessor for existing Pages projects
- [Workers static assets docs](https://developers.cloudflare.com/workers/static-assets/) - What this server wraps
- [Direct upload protocol](https://developers.cloudflare.com/workers/static-assets/direct-upload/) - The asset-upload flow behind `deploy_static_site`

## License

MIT License - see [LICENSE](LICENSE) for details.
