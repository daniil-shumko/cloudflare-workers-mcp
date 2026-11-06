/**
 * TypeScript types for Cloudflare Workers API requests/responses.
 *
 * These cover the read-only skeleton. Types for uploads (multipart metadata,
 * asset manifests, versions/deployments, domains, cron) are specified in
 * IMPLEMENTATION_PLAN.md and get added alongside their tools.
 */

export interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: ResultInfo;
}

export interface ResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
}

/** workers.dev subdomain settings on a Worker (Workers API). */
export interface WorkerSubdomain {
  enabled?: boolean;
  previews_enabled?: boolean;
  /** Read-only: https://<name>.<account>.workers.dev */
  url?: string;
  /** Read-only: suffix appended to preview slugs / version ids for preview URLs. */
  preview_url_suffix?: string;
}

/**
 * A Worker as returned by the Workers API (GET/POST/PATCH
 * /accounts/{account_id}/workers/workers[/{name}]). Holds Worker-level
 * settings; code, bindings and compatibility live on versions.
 */
export interface WorkerInfo {
  id: string;
  name: string;
  created_on?: string;
  updated_on?: string;
  deployed_on?: string | null;
  logpush?: boolean;
  observability?: Record<string, unknown>;
  subdomain?: WorkerSubdomain;
  tags?: string[];
  tail_consumers?: Array<{ name?: string; service?: string; environment?: string; namespace?: string }>;
}

/** Partial update for PATCH /workers/workers/{name} (omitted fields unchanged). */
export interface WorkerPatch {
  logpush?: boolean;
  observability?: { enabled: boolean; head_sampling_rate?: number };
  subdomain?: { enabled: boolean; previews_enabled?: boolean };
}

/**
 * One module of a downloaded Worker script. Service-worker-syntax scripts
 * yield a single module; module-syntax scripts are returned by the API as
 * multipart/form-data with one part per module.
 */
export interface WorkerModule {
  name: string;
  content_type?: string;
  content: string;
}

/** A module as stored on a version (base64 content, Workers API). */
export interface VersionModule {
  name: string;
  content_type: string;
  content_base64: string;
}

/**
 * A Worker version from the Workers API (GET/POST
 * /workers/workers/{name}/versions[/{id}], PATCH .../versions/latest).
 * Fields are flat; `modules` is present only with ?include=modules.
 */
export interface WorkerVersion {
  id: string;
  number?: number;
  created_on?: string;
  author_email?: string;
  author_id?: string;
  /** How the version was created: api | wrangler | terraform | dash | … */
  source?: string;
  annotations?: { "workers/message"?: string; "workers/tag"?: string; [key: string]: unknown };
  main_module?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings?: Array<Record<string, unknown>>;
  assets?: { config?: AssetsConfig; [key: string]: unknown };
  placement?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  usage_model?: string;
  modules?: VersionModule[];
  urls?: string[];
  startup_time_ms?: number;
}

export interface WorkerDeployment {
  id: string;
  source?: string;
  strategy?: string;
  author_email?: string;
  created_on?: string;
  annotations?: Record<string, unknown>;
  versions?: Array<{ version_id: string; percentage: number }>;
}

/** Deployments list responses wrap the array in { deployments }. */
export interface WorkerDeploymentList {
  deployments?: WorkerDeployment[];
}

export interface CronTrigger {
  cron: string;
  created_on?: string;
  modified_on?: string;
}

/** GET/PUT .../schedules responses wrap the array in { schedules }. */
export interface CronTriggerList {
  schedules?: CronTrigger[];
}

/** A custom domain attachment from /workers/domains. */
export interface WorkerDomain {
  id: string;
  cert_id?: string;
  zone_id?: string;
  zone_name?: string;
  hostname?: string;
  service?: string;
  environment?: string;
}

/** Account-level workers.dev subdomain (GET/PUT /workers/subdomain). */
export interface AccountSubdomain {
  subdomain?: string;
}

/** Asset manifest sent to .../assets-upload-session: root-relative path → hash + size. */
export type AssetManifest = Record<string, { hash: string; size: number }>;

/**
 * Result of POST .../assets-upload-session. `buckets` groups the hashes the
 * server does not already have; when it is empty, `jwt` is already the
 * completion token.
 */
export interface AssetUploadSession {
  jwt?: string;
  buckets?: string[][];
}

/** Result of a bucket upload: `jwt` present (HTTP 201) once the manifest is complete. */
export interface AssetUploadResponse {
  jwt?: string;
}

/** Static-asset serving config (metadata.assets.config on script upload). */
export interface AssetsConfig {
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  not_found_handling?: "none" | "404-page" | "single-page-application";
  run_worker_first?: boolean | string[];
  /** Public URL prefix assets are served under (default "/"); added 2026-10-28. */
  base_path?: string;
  /** Contents of a `_headers` file (not the file path). */
  _headers?: string;
  /** Contents of a `_redirects` file (not the file path). */
  _redirects?: string;
}

/** A filter leaf for the telemetry query API. */
export interface TelemetryFilter {
  key: string;
  operation: string;
  type: "string" | "number" | "boolean";
  value?: string | number | boolean;
}

/** Request body for POST .../workers/observability/telemetry/query. */
export interface TelemetryQueryRequest {
  queryId: string;
  timeframe: { from: number; to: number };
  parameters: {
    datasets: string[];
    filters?: TelemetryFilter[];
    calculations?: unknown[];
    groupBys?: unknown[];
    needle?: { value: string; isRegex?: boolean; matchCase?: boolean };
  };
  view?: "events" | "calculations" | "invocations";
  limit?: number;
  /** Events-view cursor: the `$metadata.id` of the last event of the previous page. */
  offset?: string;
  /** "next" pages toward older events (results are newest-first). */
  offsetDirection?: "next" | "prev";
  /** Execute without persisting the query run (the pattern the official MCP server uses). */
  dry?: boolean;
}

/** One Workers Logs event. Loosely typed: the payload shape varies by event. */
export interface TelemetryEvent {
  dataset?: string;
  /** Epoch milliseconds. */
  timestamp?: number;
  source?: unknown;
  $metadata?: {
    id?: string;
    message?: string;
    error?: string;
    level?: string;
    service?: string;
    trigger?: string;
    requestId?: string;
    statusCode?: number;
    duration?: number;
    url?: string;
    [key: string]: unknown;
  };
  $workers?: {
    scriptName?: string;
    outcome?: string;
    eventType?: string;
    requestId?: string;
    event?: {
      request?: { url?: string; method?: string; path?: string };
      response?: { status?: number };
      rpcMethod?: string;
    };
    cpuTimeMs?: number;
    wallTimeMs?: number;
    scriptVersion?: { id?: string; tag?: string; message?: string };
    truncated?: boolean;
    [key: string]: unknown;
  };
}

/** Result of a telemetry query in the events view. */
export interface TelemetryQueryResult {
  events?: { count?: number; events?: TelemetryEvent[] };
  [key: string]: unknown;
}

/** A secret binding as returned by the secrets endpoints (never includes the value). */
export interface WorkerSecret {
  name: string;
  type: "secret_text" | "secret_key" | string;
}

/** Result of POST .../scripts/{name}/tails. */
export interface WorkerTail {
  id: string;
  /** WebSocket URL; connect with the "trace-v1" subprotocol. */
  url: string;
  expires_at: string;
}

/** One trace-v1 tail event (loosely typed; shape varies by event kind). */
export interface TailEvent {
  outcome?: string;
  scriptName?: string;
  eventTimestamp?: number;
  cpuTime?: number;
  wallTime?: number;
  truncated?: boolean;
  scriptVersion?: { id?: string; tag?: string; message?: string };
  logs?: Array<{ message?: unknown[]; level?: string; timestamp?: number }>;
  exceptions?: Array<{ name?: string; message?: string; stack?: string; timestamp?: number }>;
  event?: {
    request?: { url?: string; method?: string; headers?: Record<string, string>; cf?: unknown };
    response?: { status?: number };
    cron?: string;
    scheduledTime?: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** A Worker Preview (beta, new Workers API). */
export interface WorkerPreview {
  id: string;
  name: string;
  slug: string;
  /** Stable alias URL(s); empty until the Worker's subdomain has previews_enabled. */
  urls?: string[];
  created_on?: string;
  updated_on?: string;
  deployed_on?: string | null;
}

/** One deployment of a Preview. */
export interface PreviewDeployment {
  id: string;
  number?: number;
  /** Per-deployment URL(s), e.g. https://<id8>-<worker>.<account>.workers.dev */
  urls?: string[];
  created_on?: string;
}

/**
 * JSON body for creating a version (POST .../versions), patching latest
 * (PATCH .../versions/latest, merge-patch: omitted fields inherit) and preview
 * deployments. Modules are base64.
 */
export interface VersionBody {
  main_module?: string;
  modules?: Array<{ name: string; content_type: string; content_base64: string }>;
  bindings?: Array<Record<string, unknown>>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: { jwt: string; config?: AssetsConfig };
  /** null clears an inherited annotation when merge-patching latest. */
  annotations?: { "workers/message"?: string | null; "workers/tag"?: string | null };
}

export type PreviewDeploymentBody = VersionBody;
