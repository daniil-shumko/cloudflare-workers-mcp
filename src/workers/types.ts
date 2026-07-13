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

/**
 * A Worker script as returned by GET /accounts/{account_id}/workers/scripts
 * (legacy Scripts API). Fields other than `id` are optional defensively —
 * the API omits several of them depending on the Worker's configuration.
 */
export interface WorkerScript {
  id: string;
  etag?: string;
  created_on?: string;
  modified_on?: string;
  usage_model?: string;
  logpush?: boolean;
  has_assets?: boolean;
  has_modules?: boolean;
  placement_mode?: string;
  last_deployed_from?: string;
  tail_consumers?: Array<{ service: string; environment?: string; namespace?: string }> | null;
  routes?: Array<{ id?: string; pattern?: string; zone_name?: string }> | null;
}

/**
 * Script settings from GET /accounts/{account_id}/workers/scripts/{script_name}/settings.
 * Bindings are kept loosely typed until the deploy tools land (35+ binding
 * variants; see IMPLEMENTATION_PLAN.md).
 */
export interface WorkerScriptSettings {
  bindings?: Array<Record<string, unknown>>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  usage_model?: string;
  logpush?: boolean;
  placement?: { mode?: string };
  tail_consumers?: Array<{ service: string; environment?: string; namespace?: string }> | null;
  observability?: Record<string, unknown>;
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

/**
 * A Worker version from GET .../scripts/{name}/versions (list) or
 * /{version_id} (detail). Annotations ("workers/message" etc.) are accepted on
 * version *upload* but are not returned by the documented read endpoints.
 */
export interface WorkerVersion {
  id: string;
  number?: number;
  metadata?: {
    author_email?: string;
    author_id?: string;
    created_on?: string;
    modified_on?: string;
    /** camelCase in the API response. */
    hasPreview?: boolean;
    source?: string;
    [key: string]: unknown;
  };
  /** Present on the version-detail and create-version endpoints only: bindings, script, script_runtime. */
  resources?: Record<string, unknown>;
  startup_time_ms?: number;
}

/** Versions list responses wrap the array in { items }. */
export interface WorkerVersionList {
  items?: WorkerVersion[];
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

/** Per-script workers.dev subdomain config (GET/POST .../scripts/{name}/subdomain). */
export interface ScriptSubdomain {
  enabled?: boolean;
  previews_enabled?: boolean;
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

/**
 * The `metadata` part of a script/version multipart upload. Only the fields
 * this server sends are typed; the API accepts more (IMPLEMENTATION_PLAN.md §3).
 */
export interface ScriptUploadMetadata {
  main_module?: string;
  bindings?: Array<Record<string, unknown>>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: { jwt?: string; config?: AssetsConfig };
  keep_assets?: boolean;
  migrations?: Record<string, unknown>;
  logpush?: boolean;
  tail_consumers?: Array<{ service: string; environment?: string; namespace?: string }>;
  placement?: { mode?: string };
  observability?: { enabled: boolean; head_sampling_rate?: number };
  annotations?: { "workers/message"?: string; "workers/tag"?: string };
}
