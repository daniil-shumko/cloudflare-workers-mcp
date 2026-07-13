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
