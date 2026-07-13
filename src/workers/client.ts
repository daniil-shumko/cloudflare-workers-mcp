/**
 * Cloudflare Workers API Client
 * Handles all HTTP communication with the Cloudflare Workers API
 */

import { TokenBucketRateLimiter } from "../utils/rate-limiter.js";
import type {
  AccountSubdomain,
  AssetManifest,
  AssetUploadResponse,
  AssetUploadSession,
  CloudflareResponse,
  CronTriggerList,
  ScriptSubdomain,
  TelemetryQueryRequest,
  TelemetryQueryResult,
  WorkerDeployment,
  WorkerDeploymentList,
  WorkerDomain,
  WorkerModule,
  WorkerScript,
  WorkerScriptSettings,
  WorkerVersion,
  WorkerVersionList,
} from "./types.js";

export class CloudflareAPIError extends Error {
  public readonly errors: Array<{ code: number; message: string }>;
  public readonly statusCode?: number;

  constructor(
    errors: Array<{ code: number; message: string }> | undefined | null,
    statusCode?: number
  ) {
    const safeErrors =
      Array.isArray(errors) && errors.length > 0
        ? errors
        : [{ code: statusCode ?? 0, message: "Unknown Cloudflare API error" }];
    const message = safeErrors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    super(message);
    this.name = "CloudflareAPIError";
    this.errors = safeErrors;
    this.statusCode = statusCode;
  }
}

/**
 * Timeout for one asset-bucket upload: a 120 s floor plus ~1 s per 100 KiB of
 * payload (a ~0.8 Mbps sustained-uplink allowance), capped at 30 minutes.
 */
export function bucketUploadTimeoutMs(payloadBytes: number): number {
  return Math.min(1_800_000, 120_000 + Math.ceil(payloadBytes / 102_400) * 1000);
}

export class WorkersClient {
  private readonly baseUrl = "https://api.cloudflare.com/client/v4";
  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly rateLimiter: TokenBucketRateLimiter;

  constructor(apiToken: string, accountId: string) {
    if (!apiToken) {
      throw new Error("Cloudflare API token is required");
    }
    if (!accountId) {
      throw new Error("Cloudflare account ID is required");
    }
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.rateLimiter = new TokenBucketRateLimiter();
  }

  /**
   * Make an authenticated request to the Cloudflare API.
   *
   * When `body` is a `FormData` instance it is sent as multipart/form-data and
   * the Content-Type header is left for `fetch` to set (so the multipart
   * boundary is generated correctly). Any other non-undefined body is sent as
   * JSON.
   *
   * `opts.bearer` overrides the account API token for the one endpoint that
   * authenticates with an upload-session JWT instead; `opts.timeoutMs` extends
   * the default 30 s bound for large multipart uploads.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>,
    opts?: { bearer?: string; timeoutMs?: number }
  ): Promise<CloudflareResponse<T>> {
    await this.rateLimiter.acquire();

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts?.bearer ?? this.apiToken}`,
    };
    if (body !== undefined && !isForm) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = opts?.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : isForm
              ? (body as FormData)
              : JSON.stringify(body),
        signal: controller.signal,
      });
      // Read the body while the abort timeout is still armed so a hung body
      // stream is bounded too, and so a read failure is handled here.
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new CloudflareAPIError(
          [{ code: 0, message: `Request timed out after ${Math.round(timeoutMs / 1000)} seconds` }],
          408
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    // Parse the body defensively: empty (204) and non-JSON error responses
    // (e.g. edge/gateway HTML) must not throw an opaque SyntaxError that hides
    // the real HTTP status.
    let data: CloudflareResponse<T> | undefined;
    if (text) {
      try {
        data = JSON.parse(text) as CloudflareResponse<T>;
      } catch {
        if (!response.ok) {
          throw new CloudflareAPIError(
            [{ code: response.status, message: this.snippet(text, response.statusText) }],
            response.status
          );
        }
        // A successful response with a non-JSON body (rare) — treat as empty.
        data = { success: true, errors: [], messages: [], result: null as T };
      }
    } else {
      // No body. A 2xx with no content is a success; anything else is an error.
      data = {
        success: response.ok,
        errors: response.ok
          ? []
          : [{ code: response.status, message: response.statusText || "Request failed" }],
        messages: [],
        result: null as T,
      };
    }

    if (!response.ok || !data.success) {
      const errors =
        Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors
          : [
              {
                code: response.status,
                message: response.statusText || "Unknown Cloudflare API error",
              },
            ];
      throw new CloudflareAPIError(errors, response.status);
    }

    return data;
  }

  /** Truncate a non-JSON error body to a short, safe message. */
  private snippet(text: string, fallback: string): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (!trimmed) return fallback || "Request failed";
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }

  // ==================== Worker Methods ====================

  /**
   * List all Worker scripts in the account (legacy Scripts API).
   */
  async listWorkers(): Promise<CloudflareResponse<WorkerScript[]>> {
    return this.request<WorkerScript[]>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts`
    );
  }

  /**
   * Get a Worker's settings (bindings, compatibility date/flags, placement,
   * observability). This is the metadata view — fetching script *content* is
   * a separate endpoint, added alongside the deploy tools.
   */
  async getWorkerSettings(
    scriptName: string
  ): Promise<CloudflareResponse<WorkerScriptSettings>> {
    return this.request<WorkerScriptSettings>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`
    );
  }

  /**
   * Download a Worker's code (legacy `GET .../scripts/{name}`). Service-worker
   * scripts come back as a single body; module-syntax scripts come back as
   * multipart/form-data with one part per module — normalized here to a
   * uniform module list. This bypasses `request()` because the response is
   * raw script content, not the JSON envelope (errors still use the envelope).
   */
  async downloadWorkerCode(
    scriptName: string
  ): Promise<{ contentType: string; modules: WorkerModule[] }> {
    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new CloudflareAPIError(
            [{ code: 0, message: "Request timed out after 30 seconds" }],
            408
          );
        }
        throw error;
      }

      if (!response.ok) {
        // Error responses use the standard JSON envelope.
        const text = await response.text();
        let errors: Array<{ code: number; message: string }> | undefined;
        try {
          errors = (JSON.parse(text) as CloudflareResponse<unknown>).errors;
        } catch {
          errors = [{ code: response.status, message: this.snippet(text, response.statusText) }];
        }
        throw new CloudflareAPIError(errors, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const form = await response.formData();
        const modules: WorkerModule[] = [];
        for (const [name, value] of form.entries()) {
          if (typeof value === "string") {
            modules.push({ name, content: value });
          } else {
            modules.push({
              name: value.name || name,
              content_type: value.type || undefined,
              content: await value.text(),
            });
          }
        }
        return { contentType, modules };
      }

      const content = await response.text();
      return {
        contentType,
        modules: [{ name: scriptName, content_type: contentType || undefined, content }],
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==================== Uploads & Lifecycle ====================

  /**
   * Start an asset upload session for a script: send the manifest, get back a
   * session JWT and the buckets of hashes Cloudflare doesn't already have.
   */
  async createAssetUploadSession(
    scriptName: string,
    manifest: AssetManifest
  ): Promise<CloudflareResponse<AssetUploadSession>> {
    return this.request<AssetUploadSession>(
      "POST",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
      { manifest }
    );
  }

  /**
   * Upload one bucket of base64-encoded asset files. Authenticates with the
   * upload-session JWT, not the account API token. The response that completes
   * the manifest (HTTP 201) carries the completion JWT in `result.jwt`. The
   * timeout scales with the payload so large buckets survive slow uplinks.
   */
  async uploadAssetBucket(
    sessionJwt: string,
    form: FormData,
    payloadBytes = 0
  ): Promise<CloudflareResponse<AssetUploadResponse>> {
    return this.request<AssetUploadResponse>(
      "POST",
      `/accounts/${this.accountId}/workers/assets/upload`,
      form,
      { base64: true },
      { bearer: sessionJwt, timeoutMs: bucketUploadTimeoutMs(payloadBytes) }
    );
  }

  /**
   * Upload (deploy) a script: multipart form with a `metadata` JSON part plus
   * zero or more module parts. Callers build the FormData (see assets.ts and
   * the deploy tools); an assets-only Worker sends metadata with no modules.
   */
  async uploadScript(
    scriptName: string,
    form: FormData
  ): Promise<CloudflareResponse<WorkerScript>> {
    return this.request<WorkerScript>(
      "PUT",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
      form,
      undefined,
      { timeoutMs: 120000 }
    );
  }

  /**
   * Partial settings update (bindings, compat date/flags, observability, …)
   * without re-uploading code. The body is multipart/form-data with a single
   * `settings` JSON part — NOT a plain JSON body.
   */
  async patchWorkerSettings(
    scriptName: string,
    settings: Record<string, unknown>
  ): Promise<CloudflareResponse<WorkerScriptSettings>> {
    const form = new FormData();
    form.append(
      "settings",
      new File([JSON.stringify(settings)], "settings.json", { type: "application/json" })
    );
    return this.request<WorkerScriptSettings>(
      "PATCH",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      form
    );
  }

  /** Delete a Worker script. `force` breaks dependencies (e.g. routes). */
  async deleteWorker(
    scriptName: string,
    force?: boolean
  ): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
      undefined,
      force ? { force: true } : undefined
    );
  }

  /** Enable/disable serving a script on workers.dev. */
  async setScriptSubdomain(
    scriptName: string,
    enabled: boolean,
    previewsEnabled?: boolean
  ): Promise<CloudflareResponse<ScriptSubdomain>> {
    return this.request<ScriptSubdomain>(
      "POST",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      previewsEnabled === undefined ? { enabled } : { enabled, previews_enabled: previewsEnabled }
    );
  }

  // ==================== Versions & Deployments ====================

  async listVersions(
    scriptName: string
  ): Promise<CloudflareResponse<WorkerVersionList | WorkerVersion[]>> {
    return this.request<WorkerVersionList | WorkerVersion[]>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`
    );
  }

  async getVersion(
    scriptName: string,
    versionId: string
  ): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions/${encodeURIComponent(versionId)}`
    );
  }

  /**
   * Upload a version WITHOUT deploying it (staged). Same multipart shape as a
   * script upload, but version metadata accepts a narrower field set (no
   * migrations/logpush/tail_consumers).
   */
  async createVersion(
    scriptName: string,
    form: FormData
  ): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>(
      "POST",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
      form,
      undefined,
      { timeoutMs: 120000 }
    );
  }

  async listDeployments(
    scriptName: string
  ): Promise<CloudflareResponse<WorkerDeploymentList>> {
    return this.request<WorkerDeploymentList>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`
    );
  }

  /**
   * Create a deployment: map live traffic onto one version (percentage 100)
   * or split it across two. Rollback is this same call with an older
   * version_id at 100%. `force` pushes past blocks like a changed secret.
   */
  async createDeployment(
    scriptName: string,
    body: {
      strategy: "percentage";
      versions: Array<{ version_id: string; percentage: number }>;
      annotations?: { "workers/message"?: string; "workers/triggered_by"?: string };
    },
    force?: boolean
  ): Promise<CloudflareResponse<WorkerDeployment>> {
    return this.request<WorkerDeployment>(
      "POST",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
      body,
      force ? { force: true } : undefined
    );
  }

  // ==================== Cron, Domains, Subdomain ====================

  async getCronTriggers(
    scriptName: string
  ): Promise<CloudflareResponse<CronTriggerList>> {
    return this.request<CronTriggerList>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`
    );
  }

  async listDomains(filters?: {
    hostname?: string;
    service?: string;
    zone_name?: string;
    zone_id?: string;
    environment?: string;
  }): Promise<CloudflareResponse<WorkerDomain[]>> {
    return this.request<WorkerDomain[]>(
      "GET",
      `/accounts/${this.accountId}/workers/domains`,
      undefined,
      filters
    );
  }

  /**
   * Replace a Worker's full cron trigger set. The PUT body is a bare JSON
   * array of {cron} objects; the {schedules: [...]} wrapper only appears in
   * responses. An empty array clears all triggers.
   */
  async setCronTriggers(
    scriptName: string,
    crons: string[]
  ): Promise<CloudflareResponse<CronTriggerList>> {
    return this.request<CronTriggerList>(
      "PUT",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
      crons.map((cron) => ({ cron }))
    );
  }

  /** Attach a custom domain to a Worker. The zone must be active in this account. */
  async attachDomain(body: {
    hostname: string;
    service: string;
    environment?: string;
    zone_id?: string;
    zone_name?: string;
  }): Promise<CloudflareResponse<WorkerDomain>> {
    return this.request<WorkerDomain>(
      "PUT",
      `/accounts/${this.accountId}/workers/domains`,
      body
    );
  }

  /** Detach a custom domain from its Worker. */
  async detachDomain(domainId: string): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      `/accounts/${this.accountId}/workers/domains/${encodeURIComponent(domainId)}`
    );
  }

  async getScriptSubdomain(
    scriptName: string
  ): Promise<CloudflareResponse<ScriptSubdomain>> {
    return this.request<ScriptSubdomain>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`
    );
  }

  async getAccountSubdomain(): Promise<CloudflareResponse<AccountSubdomain>> {
    return this.request<AccountSubdomain>(
      "GET",
      `/accounts/${this.accountId}/workers/subdomain`
    );
  }

  // ==================== Observability ====================

  /**
   * Workers Logs query API (the endpoint the official observability MCP
   * server wraps). Requires the Worker to have observability enabled.
   */
  async queryTelemetry(
    body: TelemetryQueryRequest
  ): Promise<CloudflareResponse<TelemetryQueryResult>> {
    return this.request<TelemetryQueryResult>(
      "POST",
      `/accounts/${this.accountId}/workers/observability/telemetry/query`,
      body
    );
  }

  // ==================== Utility Methods ====================

  /**
   * Verify the API token. Tries the account-scoped verify endpoint first
   * (authoritative for account-owned tokens), then falls back to the
   * user-scoped endpoint: a valid *user* token returns an auth error (not a
   * 404) from the account-scoped endpoint, so the fallback must not be gated
   * on 404 alone. Returns a structured result so callers can distinguish a
   * genuine auth failure from a network/transport error.
   */
  async verifyToken(): Promise<{ valid: boolean; status?: string; detail?: string }> {
    const tryVerify = async (
      path: string
    ): Promise<{ ok: boolean; status?: string; detail?: string }> => {
      // Bound the whole call (including the body read) like request() does —
      // health_check is the tool users reach for when things hang, so it must
      // never hang itself. A timeout rejects and is reported as valid:false.
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      let data: CloudflareResponse<{ status?: string }> | undefined;
      try {
        data = text ? (JSON.parse(text) as CloudflareResponse<{ status?: string }>) : undefined;
      } catch {
        data = undefined;
      }
      return {
        ok: response.ok && !!data?.success,
        status: data?.result?.status,
        detail: data?.errors?.map((e) => `[${e.code}] ${e.message}`).join("; ") || response.statusText,
      };
    };

    try {
      const accountRes = await tryVerify(`/accounts/${this.accountId}/tokens/verify`);
      if (accountRes.ok) {
        return { valid: true, status: accountRes.status };
      }
      // Fall back to the user-scoped endpoint, which is authoritative for
      // user-created tokens (the kind the README's quick-start recommends).
      const userRes = await tryVerify(`/user/tokens/verify`);
      if (userRes.ok) {
        return { valid: true, status: userRes.status };
      }
      // Both failed — surface the user-endpoint detail (more meaningful for the
      // common user-token case), falling back to the account-endpoint detail.
      return { valid: false, detail: userRes.detail || accountRes.detail };
    } catch (error) {
      return {
        valid: false,
        detail: `Could not reach Cloudflare: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get account ID
   */
  getAccountId(): string {
    return this.accountId;
  }
}
