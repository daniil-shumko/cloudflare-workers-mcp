# Implementation Plan — Cloudflare Workers MCP Server

Sibling of [cloudflare-pages-mcp](https://github.com/daniil-shumko/cloudflare-pages-mcp)
(local path: `~/workspace/personal/cloudflare-pages-mcp`), which is now in
maintenance mode along with Cloudflare Pages itself. All API facts below were
verified against live Cloudflare docs and repos on **2026-07-13** (re-checked **2026-11-05**); sources at
the bottom. Re-verify anything marked *beta* before building on it.

## 1. Why this server exists

Cloudflare recommends Workers with static assets for all new projects — since
the 2025-04-08 blog post all new feature investment goes to Workers, while
Pages remains supported ("maintenance mode" is the community shorthand, not
Cloudflare's official wording). But as of July 2026 **no MCP server — official
or community — can actually deploy a Worker**:

- Cloudflare's domain-specific remote servers (`bindings.`/`builds.`/
  `observability.mcp.cloudflare.com`) are **read-only for Workers** (list, get
  code, query logs/builds). Deploy feature requests (cloudflare/mcp-server-cloudflare
  issues #63, #213, #246) were closed without action.
- Cloudflare's Code Mode server (`mcp.cloudflare.com`) can hit any REST
  endpoint by generating JS in a sandbox, but the sandbox has **no
  filesystem** — every asset byte must be inlined in generated code, so real
  static sites are impractical.
- The only official artifact that ever had a `worker_put` deploy tool is the
  unmaintained 2024 local server (`@cloudflare/mcp-server-cloudflare` v0.2.0).

A **local stdio MCP server with filesystem access** (this repo) can offer what
none of them do: *"deploy this directory as a static site on Workers"* — the
Workers asset-upload protocol is publicly documented (unlike Pages Direct
Upload, which cloudflare-pages-mcp deliberately skipped as wrangler territory).

## 2. API strategy

Two API styles exist; **v1 of this server uses the legacy API for everything**,
because it is stable and covers the full surface. Revisit the beta API when it
goes GA (it doesn't yet cover cron triggers or custom-domain attach; workers.dev
subdomain settings *are* covered, as a field on the beta Worker object).

| | Legacy Scripts API | Beta Workers API |
| --- | --- | --- |
| Base | `/accounts/{account_id}/workers/scripts/{script_name}` | `/accounts/{account_id}/workers/workers/{worker_id}` |
| Model | script name is the key | Worker (stable UUID) → Version (immutable) → Deployment |
| Script upload | multipart form: `metadata` JSON part + one part per module | pure JSON; modules as `{name, content_type, content_base64}`; `?deploy=true` deploys in one call |
| Status | working; **tagged `deprecated` in the OpenAPI schema** (as of 2026-11-05, SDK group `workers.legacy.scripts`) for `GET /scripts`, `GET/PUT/DELETE /scripts/{name}`, `/settings`, `/subdomain`, `/versions` — no `deprecated: true` flag, no sunset date, no changelog post, not on the API deprecations page. `/deployments`, `/schedules`, `/secrets`, asset upload, `/domains`, account `/subdomain`, telemetry stay GA | **GA** (`x-fern-availability: generally-available`, seen 2026-11-05); beta since 2025-09-03 |
| Coverage | everything below | script/version/deployment + subdomain `{enabled, previews_enabled}` on the Worker object + Worker Previews (beta) — no cron, no custom-domain attach |

**Migration watch (2026-11-05):** nothing forces a move yet, but the
deprecation tag signals a sunset is coming. Plan to move upload, settings,
versions and subdomain onto `/workers/workers` (stable UUIDs, pure-JSON
upload). Re-check the deprecations page before each release.

## 3. Endpoint reference (legacy API unless noted)

All paths relative to `https://api.cloudflare.com/client/v4/accounts/{account_id}`.

### Scripts
- `GET  /workers/scripts` — list Workers *(implemented: `list_workers`)*
- `GET  /workers/scripts/{name}/settings` — bindings, compat date/flags, placement, observability *(implemented: `get_worker`)*
- `GET  /workers/scripts/{name}` — download script content
- `PUT  /workers/scripts/{name}` — upload/deploy. Multipart form:
  - `metadata` part (JSON): `main_module` (or `body_part` for service-worker
    syntax), `bindings[]`, `compatibility_date`, `compatibility_flags`,
    `migrations`, `assets {jwt, config}`, `keep_assets`, `logpush`,
    `tail_consumers`, `annotations`, `placement`, `observability`
  - one form part per module, content type `application/javascript+module`
    (also `text/javascript+module`, wasm, source maps, etc.)
  - **assets-only Worker**: metadata with `assets` and *no* main_module is
    valid — that is how a pure static site deploys. Caveat: the
    multipart-upload-metadata docs page still says "main_module is required"
    (stale wording); the OpenAPI schema marks **no** metadata field required,
    and wrangler's `create-worker-upload-form.ts` has an explicit assets-only
    short-circuit that sends zero module parts. Confirm in the M2 live e2e.
- `DELETE /workers/scripts/{name}` (`?force=true` to break dependencies)
- `PATCH /workers/scripts/{name}/settings` — partial settings update (bindings
  etc.) without re-uploading code. Body is **multipart/form-data with a single
  `settings` JSON part**, not a plain JSON body (reuse the FormData
  pass-through in `WorkersClient`)

### Static assets direct upload (the headline feature)
Documented for programmatic integrations at
`developers.cloudflare.com/workers/static-assets/direct-upload/`:

1. Build a **manifest** of every file in the site directory:
   `{ "/path/relative/to/root": { "hash": ..., "size": <bytes> } }`. The hash
   is the **first 32 hex chars of SHA-256 over `base64(fileContent) +
   fileExtensionWithoutDot`** — NOT over the raw bytes. That is the formula in
   the docs' canonical example; wrangler itself uses BLAKE3 over the same
   input, so the server treats the hash as an opaque client fingerprint —
   but matching the documented formula is the documented protocol and keeps
   this server's dedupe self-consistent across its own deploys.
2. `POST /workers/scripts/{name}/assets-upload-session` with `{manifest}` →
   `{jwt, buckets: [[hash, ...], ...]}`. The JWT lives **1 hour**. `buckets`
   groups only the hashes Cloudflare does **not** already have (dedupe across
   deploys is server-side — unchanged files never re-upload). **If `buckets`
   is empty, the session JWT doubles as the completion token — skip step 3.**
3. For each bucket: `POST /workers/assets/upload?base64=true` as multipart
   with `Authorization: Bearer <session JWT>`; one form part per file, field
   name = the file's hash, value = base64 file content, content type set per
   file. The **final** bucket upload returns a **completion JWT** (also 1 h).
4. Reference the completion JWT in the script upload's `metadata.assets.jwt`,
   with `assets.config` = `{html_handling? ("auto-trailing-slash" |
   "force-trailing-slash" | "drop-trailing-slash" | "none"),
   not_found_handling? ("none" | "404-page" | "single-page-application"),
   run_worker_first? (bool or glob array), _headers?, _redirects?}`.
   **`_headers`/`_redirects` are NOT uploaded as ordinary assets**: read them
   from the asset root, EXCLUDE them from the manifest (wrangler
   default-ignores `/_headers`, `/_redirects`, `/.assetsignore`), and pass
   their *contents* as the `assets.config._headers` / `assets.config._redirects`
   strings — uploading them as assets would serve the raw rule files publicly
   and apply none of the rules. Use `keep_assets: true` instead of a JWT to
   redeploy code while reusing the previous version's assets.

Limits: 20,000 files/version (free) or 100,000 (paid), 25 MiB/file. Asset
requests are free/unmetered at serve time.

### Versions & deployments (gradual rollouts)
- `GET/POST /workers/scripts/{name}/versions` — list/upload a version without
  deploying (staged); `GET .../versions/{version_id}` for detail
- `GET/POST /workers/scripts/{name}/deployments` — a deployment maps traffic
  to versions: `{strategy: "percentage", versions: [{version_id, percentage}]}`;
  100/0 → single-version deploy, 90/10 → gradual rollout; rollback = deploy an
  older version_id at 100%

### Domains, subdomain, cron, logs
- `GET/PUT /workers/domains` — attach a custom domain
  `{zone_id, hostname, service, environment}`; `GET /workers/domains/{domain_id}`,
  `DELETE /workers/domains/{domain_id}`. **The zone must be active in this
  account** (unlike Pages, external zones are unsupported — official matrix).
- `GET/PUT /workers/subdomain` — account-level `<sub>.workers.dev` subdomain
- `GET/POST /workers/scripts/{name}/subdomain` — per-script
  `{enabled, previews_enabled}` (workers.dev serving + preview URLs)
- `GET/PUT /workers/scripts/{name}/schedules` — cron triggers. PUT body is a
  **bare JSON array** `[{"cron": "*/30 * * * *"}, ...]` and replaces the full
  set; the `{schedules: [...]}` wrapper appears only in the *response* under
  `result`
- `POST /workers/observability/telemetry/query` — Workers Logs query API
  (same endpoint the official observability MCP server wraps); also
  `/telemetry/keys` and `/telemetry/values`. Requires the Worker to have
  `observability: {enabled: true}`. Legacy alternative: the tail API
  (WebSocket) — skip it; the query API is the documented, pull-based fit here.

### Token verification (health_check — implemented)
- `GET /accounts/{account_id}/tokens/verify`, falling back to
  `GET /user/tokens/verify` (user-created tokens fail the account-scoped
  endpoint with an auth error, not a 404).

## 4. Proposed tool surface (~20 tools)

**Worker tools** — `list_workers` ✅, `get_worker` ✅ (settings; consider
folding in cron + subdomain status), `get_worker_code`, `deploy_worker`
(script upload with modules/bindings/compat), `delete_worker`,
`update_worker_settings` (PATCH settings)

**Static site tools (the differentiator)** — `deploy_static_site`
(directory → manifest → asset upload → assets-only Worker; options:
`html_handling`, `not_found_handling`, SPA mode, `run_worker_first`),
`redeploy_assets` (`keep_assets` variants)

**Version/deployment tools** — `list_versions`, `get_version`,
`create_version` (staged upload), `list_deployments`, `create_deployment`
(incl. gradual `percentage` splits), `rollback_worker` (older version → 100%)

**Domain & routing tools** — `list_worker_domains`, `add_worker_domain`,
`delete_worker_domain`, `set_workers_dev` (per-script subdomain
enabled/previews), `set_cron_triggers`, `get_cron_triggers`

**Observability** — `query_worker_logs` (telemetry query with sensible
defaults: time range, worker filter, limit), `health_check` ✅

Follow the pages-mcp conventions: one Zod schema per tool, summarized
responses, `readOnlyHint`/`destructiveHint` annotations on every tool.

## 5. Milestones

- **M1 — read-only surface** *(skeleton done)*: list/get ✅, plus
  `get_worker_code`, `list_versions`, `list_deployments`, cron/domain/subdomain
  getters. Ship criteria: protocol test green, README quick start.
- **M2 — static site deploy**: manifest hashing (`node:crypto`; first 32 hex
  of `sha256(base64(content) + extension)` — see §3), upload-session flow,
  bucket batching, base64 multipart,
  MIME-by-extension table, empty-bucket fast path, assets-only Worker upload,
  `not_found_handling`/SPA options. Implement the guarded live e2e
  (`test/integration/`) with this milestone — deploy a tiny throwaway site,
  fetch it over HTTP, delete it, always-cleanup.
- **M3 — script deploy & lifecycle**: `deploy_worker` (modules + bindings
  subset: plain_text, secret_text, kv_namespace, r2_bucket, d1, assets),
  `delete_worker`, `update_worker_settings`.
- **M4 — versions, deployments, rollback**: staged versions, percentage
  deployments, `rollback_worker`.
- **M5 — domains, subdomain, cron**.
- **M6 — observability**: `query_worker_logs` on the telemetry query API.

## 6. Design decisions & gotchas

- **Multipart uploads**: `WorkersClient.request()` already passes `FormData`
  through without forcing a JSON content type (ported from pages-mcp). Use
  `new File([...], name, {type})` parts; `undici`'s FormData ships with
  Node ≥ 22.
- **Asset upload auth differs**: `POST /workers/assets/upload` authenticates
  with the **session JWT**, not the account API token — the client needs a
  "raw bearer override" path for that one call.
- **JWT lifetime is 1 h** for both session and completion tokens — fine for
  interactive use; surface a clear error if an upload session goes stale.
- **Path normalization**: manifest paths start with `/` and are relative to
  the asset root; reject `..`, symlinks pointing outside the root, and
  non-regular files when walking the directory.
- **File limits**: enforce 20k/100k files and 25 MiB/file client-side with a
  readable error *before* starting uploads.
- **Error suggestions**: `utils/errors.ts` carries the auth-code suggestions
  verified in pages-mcp (6003/6111, 10000, 9109, 7000); add Workers-specific
  codes (e.g. 10007 script_not_found) as they are observed against the live
  API — don't guess them into the suggestion table untested.
- **`keep_assets` ignores `assets.config` (verified live 2026-11-05)**: a
  `keep_assets: true` upload keeps the previous version's assets *and* asset
  config. Any `assets.config` sent alongside it is silently dropped, so
  `html_handling`/`not_found_handling`/`base_path` changes need a fresh
  upload-session JWT. `deploy_static_site` gets that cheaply, since unchanged
  files dedupe to 0 uploads. That's why `redeploy_assets` has no config inputs
  and a `.strict()` schema. (v1.0.0 advertised config inputs there that were
  no-ops.)
- **`assets.config.base_path` is gated per account**: added 2026-10-28, but a
  non-root value returns `[100343] A non-root assets.base_path is not enabled
  for this account.` on accounts without the rollout. The kustos test account
  is one of these, so the live test can't cover it yet.
- **Telemetry pagination**: `events.count` is the *page* size, not a total.
  Events come newest-first. Pass the last event's `$metadata.id` as `offset`
  with `offsetDirection: "next"` to get the next older page with no overlap
  (verified live 2026-11-05). `query_worker_logs` exposes this as
  `cursor`/`next_cursor`.
- **Compatibility dates**: `nodejs_compat` (+ `_v2`) is on by default for
  `compatibility_date >= 2026-08-04`, so the today-default needs no flag.
- **Deliberate non-goals for v1**: routes on zones (`/zones/{id}/workers/routes`
  — zone-scoped tokens complicate the permission story), Workers-for-Platforms
  dispatch namespaces, Durable Object migrations beyond pass-through, tail
  WebSocket streaming, KV/R2/D1 CRUD (the official bindings MCP server already
  does this well — don't duplicate it).

## 7. Architecture (mirrors cloudflare-pages-mcp)

```
src/
├── index.ts             # MCP server entry; addTool(name, config, handler) helper —
│                        #   one Zod schema per tool, SDK validates, z.infer types args
├── workers/
│   ├── client.ts        # WorkersClient (Bearer auth, rate-limited, CloudflareAPIError)
│   ├── assets.ts        # (M2) manifest hashing + upload-session/bucket flow
│   ├── summarize.ts     # pure response summarizers
│   └── types.ts         # API request/response types
└── utils/
    ├── config.ts        # env loader (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
    ├── errors.ts        # formatError/formatSuccess + suggestion table
    └── rate-limiter.ts  # token bucket (20 rps, burst 50)
```

Tests: Node's built-in runner via tsx — `test/unit` (mocked fetch),
`test/protocol` (real server over MCP stdio, dummy creds, asserts the
advertised tool set), `test/integration` (guarded live e2e). See `test/README.md`.

## 8. Toolchain constraints (inherited from pages-mcp, July 2026)

- **TypeScript 7** (Go compiler): `tsc --noEmit` works; **no programmatic
  compiler API until 7.1**, so tsup `--dts` crashes — build stays
  `tsup src/index.ts --format esm --clean`, no declarations (bin-only package).
- **MCP SDK v2** (migrated 2026-11-05, from v1 1.32.2): `@modelcontextprotocol/server`
  (runtime) and `@modelcontextprotocol/client` (tests only). The codemod
  (`npx @modelcontextprotocol/codemod v1-to-v2 .`) did only the imports.
  The manual changes:
  - Entry point is now `serveStdio(() => buildServer(workers))`, which serves
    both the 2025 and 2026-07-28 protocol eras.
  - Tests no longer match `-32602` in rendered text, because v2 dropped the
    `MCP error <code>:` prefix. They match `Input validation error`.
  - Unknown tools now reject with a protocol error instead of resolving
    `isError`.
  - zod must be ≥ 4.2.
- **`@types/node` stays ^22** to match `engines.node >=22` — bumping it lets
  Node-26-only APIs pass typecheck but crash on supported LTS.

## 9. Sources (all verified 2026-07-13)

- Asset direct upload protocol: developers.cloudflare.com/workers/static-assets/direct-upload/
- Multipart script metadata: developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- Static assets config (`assets.directory`, `not_found_handling`, `run_worker_first`): developers.cloudflare.com/workers/static-assets/
- Billing ("requests to static assets are free and unlimited"): developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Beta Workers API announcement (2025-09-03): developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/
- Beta versions endpoint (`content_base64`, `?deploy=true`): developers.cloudflare.com/api/resources/workers/subresources/beta/
- Pages→Workers migration guide + compatibility matrix (updated 2026-07-03): developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
- Official MCP servers are read-only for Workers: github.com/cloudflare/mcp-server-cloudflare (apps/workers-bindings; issues #63, #213, #246)
- Observability telemetry query API: developers.cloudflare.com/workers/observability/ (+ packages/mcp-common/src/api/workers-observability.api.ts in the repo above)
- File limits (100k paid since 2025-09-02): developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/

Added 2026-11-05:
- OpenAPI schema (legacy-Scripts `deprecated` tags, Workers API GA, telemetry `offset`/`offsetDirection`): raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
- `assets.base_path` (2026-10-28): developers.cloudflare.com/changelog/post/2026-10-28-static-assets-base-path/ and developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/
- `nodejs_compat` default for compat dates ≥ 2026-08-04: developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/
- API deprecations page (lists only KV legacy routes as of 2026-11-05): developers.cloudflare.com/fundamentals/api/reference/deprecations/

## 10. Post-v1 additions & the Workers API migration plan (2026-11-05)

### New tools: protocol facts, all verified live 2026-11-05
- **Secrets** (`list_secrets`, `set_secrets`, `delete_secret`). These are GA
  scripts-path endpoints: `GET /scripts/{n}/secrets`,
  `PATCH /scripts/{n}/secrets-bulk` and `DELETE /scripts/{n}/secrets/{name}`.
  - The bulk patch is a JSON Merge Patch, `{secrets: {NAME: {type: "secret_text", text} | null}}`.
    `null` deletes, and the whole patch produces ONE version that is
    **deployed immediately**.
  - Reads return only `{name, type}`.
  - Deleting a missing secret returns error 10056.
- **Live tail** (`tail_worker`) uses the classic `POST /scripts/{n}/tails`
  (GA), which returns `{id, url, expires_at}`.
  - Open a WebSocket to `url` with subprotocol `trace-v1` and send
    `{"debug":false}`. Each frame is one JSON event: `outcome`,
    `eventTimestamp`, `logs[{message[], level}]`, `exceptions[{name, message}]`,
    `event.request{url, method, headers, cf}` and `event.response.status`.
  - Delete the tail afterwards with `DELETE /tails/{id}`.
  - This works on any Worker, with no observability needed. We filter
    client-side because the server-side filter vocabulary is undocumented.
  - The observability `POST /observability/telemetry/live-tail` alternative
    needs a heartbeat loop and an undocumented `scriptId`, so it isn't used.
- **Worker Previews** (`deploy_preview`, `list_previews`, `delete_preview`)
  are beta and exist only on `/workers/workers/{name}/previews`.
  - `POST` with `{name}` creates a preview.
  - `POST /previews/{id}/deployments` takes a JSON body with base64
    `modules` or `assets{jwt, config}`. The JWT from the normal scripts-path
    upload session works, and `config._headers` applies.
  - **URLs are only routable when the Worker's subdomain has
    `previews_enabled`**: the stable `https://<slug>-<worker>.<acct>.workers.dev`,
    and per deployment `https://<id8>-…`. Production deployments are never
    touched.

### Migrating off the deprecated legacy endpoints: assessment
**Effort: moderate, about 2–3 focused days.** 11 of the 24 `WorkersClient`
methods change, and 13 stay on GA scripts-path endpoints: deployments (and
so rollback), schedules, domains, account subdomain, asset upload, telemetry,
secrets and tails.

Facts that make it tractable:
- The new API accepts the Worker **name** as `{worker_id}` [verified live].
- Legacy-created Workers are addressable there [verified live].
- Pairing new-API version creation with the legacy `/deployments` endpoint
  is the documented pattern [docs].

Method mapping:

| Method | Replacement |
| --- | --- |
| `listWorkers` | `GET /workers/workers`. Paginated, and drops `has_assets`/`usage_model`. |
| `getWorkerSettings` | `GET /workers/workers/{n}` (logpush, observability, subdomain, tags) **plus** the deployed version (bindings, compat, placement, assets config). Find the deployed version via `/deployments`, **never** `latest`, which means "newest created". |
| `downloadWorkerCode` | `GET …/versions/{id}?include=modules`. Base64 JSON, so the multipart parser goes away. |
| `uploadScript` | Ensure the Worker exists (`POST /workers/workers`), then `POST …/versions?deploy=true` with base64 modules and `assets.jwt`. Per [docs], `_headers`/`_redirects` become `text/plain` modules on versions. |
| `patchWorkerSettings` | `PATCH /workers/workers/{n}` **plus** `PATCH …/versions/latest?deploy=true`. Two calls, so no longer atomic. |
| `deleteWorker`, script subdomain, `list/get/createVersion` | Same-shaped new endpoints. |

Blockers and risks:
1. **The new API has no `keep_assets`**. `PATCH …/versions/latest` inherits
   omitted fields, but whether that includes assets is unverified, and it's
   tied to `latest`. Keep `redeploy_assets` and keep_assets code deploys on
   legacy `PUT /scripts` until there's an equivalent.
2. **Assets-only versions** (zero modules) and `_headers`-as-module on
   production versions are unverified. Test these live first. (Previews do
   work assets-only, see above.)
3. **`get_worker_code` for old service-worker-syntax Workers** is unknown on
   the new API.
4. **Deploying staged code by accident** if anything resolves `latest`
   instead of the deployed version.
5. **Base64 makes uploads about 33% larger.**

Staging, each stage shippable on its own:
1. Reads: list, get, versions, code download, subdomain.
2. `deleteWorker` and `setScriptSubdomain`.
3. `createVersion` with a shared `toVersionBody()`/`ensureWorker()`.
4. `deploy_worker`, then `deploy_static_site`.
5. `update_worker_settings`/`redeploy_assets` last. Keep these two on
   legacy if blocker 1 still holds.

Extend the guarded live test at each stage: a `_headers` rule served,
`get_worker_code` round-trip, and a legacy-created Worker redeployed via the
new paths. Re-check Cloudflare's API deprecations page before each release;
as of 2026-11-05 nothing forces the move.
