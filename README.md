# Cloudflare Workers MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

> 🚧 **Early development** — this server currently ships a small read-only
> tool set. The deploy tools (the point of the project) are specced and
> in progress; see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the
> roadmap.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for
managing Cloudflare Workers from Claude Desktop or Claude Code — the successor
to [cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp),
following Cloudflare's own shift from Pages to
[Workers with static assets](https://developers.cloudflare.com/workers/static-assets/).

## Why

As of mid-2026, no MCP server — including Cloudflare's official ones — can
deploy a Worker. Cloudflare's remote MCP servers are read-only for Workers
management, and their Code Mode server has no filesystem so it can't upload
real asset trees. A local stdio server can: the Workers static-asset upload
protocol is [publicly documented](https://developers.cloudflare.com/workers/static-assets/direct-upload/),
so this server's headline goal is:

> *"Deploy this directory as a static site on Cloudflare Workers"* — in one
> natural-language request, with free unlimited static hosting.

## Tools

### Available now (read-only skeleton)
- **list_workers** - List all Worker scripts in your account
- **get_worker** - Get a Worker's settings: bindings, compatibility date/flags, placement, observability
- **health_check** - Verify API token and connection to Cloudflare

### Planned (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md))
- **deploy_static_site** - Deploy a local directory as a static site (manifest hashing, deduped uploads, SPA/404 handling)
- **deploy_worker / delete_worker / get_worker_code** - Script lifecycle
- **Versions & deployments** - Staged uploads, gradual percentage rollouts, rollback
- **Custom domains, workers.dev subdomain, cron triggers**
- **query_worker_logs** - Workers Logs via the observability query API

## Quick Start (development)

Requires **Node.js 22+**. Not published to npm — build from source:

```bash
git clone https://github.com/daniil-shumko/cloudflare-workers-mcp
cd cloudflare-workers-mcp
npm install
npm run build
npm test        # unit + MCP protocol smoke, no creds needed
```

### Configure Claude Desktop/Code

Create an API token with **Workers Scripts: Edit** (the "Edit Cloudflare
Workers" template works), find your account ID in the
[dashboard](https://dash.cloudflare.com), then:

```json
{
  "mcpServers": {
    "cloudflare-workers": {
      "command": "node",
      "args": ["/absolute/path/to/cloudflare-workers-mcp/dist/index.js"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your_token_here",
        "CLOUDFLARE_ACCOUNT_ID": "your_account_id_here"
      }
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add cloudflare-workers \
  -e CLOUDFLARE_API_TOKEN=your_token_here \
  -e CLOUDFLARE_ACCOUNT_ID=your_account_id_here \
  -- node /absolute/path/to/cloudflare-workers-mcp/dist/index.js
```

## Related Links

- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) - Roadmap, verified API reference, design decisions
- [cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp) - The maintenance-mode predecessor for existing Pages projects
- [Workers static assets docs](https://developers.cloudflare.com/workers/static-assets/) - What this server wraps
- [Direct upload protocol](https://developers.cloudflare.com/workers/static-assets/direct-upload/) - The asset-upload flow behind `deploy_static_site`

## License

MIT License - see [LICENSE](LICENSE) for details.
