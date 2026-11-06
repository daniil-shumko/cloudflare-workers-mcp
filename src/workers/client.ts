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
  PreviewDeployment,
  PreviewDeploymentBody,
  TelemetryQueryRequest,
  TelemetryQueryResult,
  VersionBody,
  WorkerDeployment,
  WorkerDeploymentList,
  WorkerDomain,
  WorkerInfo,
  WorkerModule,
  WorkerPatch,
  WorkerPreview,
  WorkerSecret,
  WorkerTail,
  WorkerVersion,
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

  // ==================== Workers (Workers API, GA) ====================
  //
  // /accounts/{id}/workers/workers/{worker} accepts the Worker NAME as the id,
  // so every tool keeps taking script names. These replace the legacy
  // /workers/scripts endpoints that Cloudflare's schema now tags deprecated.
  // Deployments, schedules, domains, secrets, tails and asset upload stay on
  // their (GA) scripts paths.

  private workerPath(scriptName: string): string {
    return `/accounts/${this.accountId}/workers/workers/${encodeURIComponent(scriptName)}`;
  }

  /** All Workers in the account (walks every page; the API caps per_page at 100). */
  async listWorkers(): Promise<WorkerInfo[]> {
    const all: WorkerInfo[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request<WorkerInfo[]>(
        "GET",
        `/accounts/${this.accountId}/workers/workers`,
        undefined,
        { page, per_page: 100 }
      );
      const items = response.result ?? [];
      all.push(...items);
      const total = response.result_info?.total_count;
      if (items.length < 100 || (total !== undefined && all.length >= total)) break;
    }
    return all;
  }

  async getWorker(scriptName: string): Promise<CloudflareResponse<WorkerInfo>> {
    return this.request<WorkerInfo>("GET", this.workerPath(scriptName));
  }

  /** Create an (empty, undeployed) Worker; upload a version to give it code or assets. */
  async createWorker(
    scriptName: string,
    settings: WorkerPatch = {}
  ): Promise<CloudflareResponse<WorkerInfo>> {
    return this.request<WorkerInfo>("POST", `/accounts/${this.accountId}/workers/workers`, {
      name: scriptName,
      ...settings,
    });
  }

  /** Partial update of Worker-level settings (logpush, observability, subdomain). */
  async patchWorker(scriptName: string, patch: WorkerPatch): Promise<CloudflareResponse<WorkerInfo>> {
    return this.request<WorkerInfo>("PATCH", this.workerPath(scriptName), patch);
  }

  /** Delete a Worker with all versions, deployments and assets. `force` breaks dependencies. */
  async deleteWorker(scriptName: string, force?: boolean): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      this.workerPath(scriptName),
      undefined,
      force ? { force: true } : undefined
    );
  }

  /**
   * Download a Worker's code via the LEGACY `GET .../scripts/{name}` (deprecated
   * endpoint). Only used as a fallback for service-worker-syntax Workers, whose
   * versions carry no `modules` on the Workers API (verified live 2026-11-05). Service-worker
   * scripts come back as a single body; module-syntax scripts come back as
   * multipart/form-data with one part per module — normalized here to a
   * uniform module list. This bypasses `request()` because the response is
   * raw script content, not the JSON envelope (errors still use the envelope).
   */
  async downloadLegacyScript(
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

  // ==================== Asset uploads (GA scripts path) ====================

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

  // ==================== Versions (Workers API, GA) ====================

  /** The most recent versions, newest first (single page of up to `perPage`, max 100). */
  async listVersions(scriptName: string, perPage = 100): Promise<CloudflareResponse<WorkerVersion[]>> {
    return this.request<WorkerVersion[]>(
      "GET",
      `${this.workerPath(scriptName)}/versions`,
      undefined,
      { per_page: perPage }
    );
  }

  /** One version; `includeModules` adds the base64 code (can be megabytes). */
  async getVersion(
    scriptName: string,
    versionId: string,
    includeModules = false
  ): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>(
      "GET",
      `${this.workerPath(scriptName)}/versions/${encodeURIComponent(versionId)}`,
      undefined,
      includeModules ? { include: "modules" } : undefined
    );
  }

  /**
   * Create a version from a complete body. `deploy: true` also deploys it to
   * 100% of traffic in the same call; otherwise it is staged.
   */
  async createVersion(
    scriptName: string,
    body: VersionBody,
    deploy: boolean
  ): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>(
      "POST",
      `${this.workerPath(scriptName)}/versions`,
      body,
      deploy ? { deploy: true } : undefined,
      { timeoutMs: 120000 }
    );
  }

  /**
   * Create a version by merge-patching the LATEST version: omitted fields
   * (including assets) are inherited. "Latest" means most recently CREATED,
   * which may be a staged version — callers must check it is the live one.
   */
  async patchLatestVersion(
    scriptName: string,
    patch: Partial<VersionBody>,
    deploy: boolean
  ): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>(
      "PATCH",
      `${this.workerPath(scriptName)}/versions/latest`,
      patch,
      deploy ? { deploy: true } : undefined,
      { timeoutMs: 120000 }
    );
  }

  /** Metadata of the most recently created version (no modules). */
  async getLatestVersion(scriptName: string): Promise<CloudflareResponse<WorkerVersion>> {
    return this.request<WorkerVersion>("GET", `${this.workerPath(scriptName)}/versions/latest`);
  }

  // ==================== Deployments (GA scripts path) ====================

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

  async getAccountSubdomain(): Promise<CloudflareResponse<AccountSubdomain>> {
    return this.request<AccountSubdomain>(
      "GET",
      `/accounts/${this.accountId}/workers/subdomain`
    );
  }

  // ==================== Secrets ====================
  //
  // GA endpoints on the scripts path (not part of the legacy-API deprecation).
  // Reads return only {name, type} — values are never echoed. Every write
  // creates AND deploys a new version (verified live 2026-11-05).

  async listSecrets(scriptName: string): Promise<CloudflareResponse<WorkerSecret[]>> {
    return this.request<WorkerSecret[]>(
      "GET",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`
    );
  }

  /**
   * Create/update/delete several secrets in ONE new version (JSON Merge
   * Patch): a string value sets a secret_text, null deletes, omitted names
   * are left unchanged.
   */
  async patchSecrets(
    scriptName: string,
    secrets: Record<string, string | null>
  ): Promise<CloudflareResponse<Record<string, WorkerSecret>>> {
    const body = {
      secrets: Object.fromEntries(
        Object.entries(secrets).map(([name, text]) => [
          name,
          text === null ? null : { type: "secret_text", text },
        ])
      ),
    };
    return this.request<Record<string, WorkerSecret>>(
      "PATCH",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets-bulk`,
      body
    );
  }

  async deleteSecret(scriptName: string, secretName: string): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(
        scriptName
      )}/secrets/${encodeURIComponent(secretName)}`
    );
  }

  // ==================== Worker Previews (beta, new Workers API) ====================
  //
  // Only exist on /workers/workers/{worker}. That path accepts the Worker
  // NAME as the id, so callers keep using script names. Verified live
  // 2026-11-05: preview deployments never touch production; preview URLs are
  // only routable once the Worker's subdomain has previews_enabled.

  async listPreviews(
    scriptName: string,
    filters?: { name?: string; page?: number; per_page?: number }
  ): Promise<CloudflareResponse<WorkerPreview[]>> {
    return this.request<WorkerPreview[]>(
      "GET",
      `${this.workerPath(scriptName)}/previews`,
      undefined,
      filters as Record<string, string | number | undefined> | undefined
    );
  }

  async createPreview(scriptName: string, name: string): Promise<CloudflareResponse<WorkerPreview>> {
    return this.request<WorkerPreview>("POST", `${this.workerPath(scriptName)}/previews`, { name });
  }

  async getPreview(scriptName: string, previewId: string): Promise<CloudflareResponse<WorkerPreview>> {
    return this.request<WorkerPreview>(
      "GET",
      `${this.workerPath(scriptName)}/previews/${encodeURIComponent(previewId)}`
    );
  }

  async deletePreview(scriptName: string, previewId: string): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      `${this.workerPath(scriptName)}/previews/${encodeURIComponent(previewId)}`
    );
  }

  async createPreviewDeployment(
    scriptName: string,
    previewId: string,
    body: PreviewDeploymentBody
  ): Promise<CloudflareResponse<PreviewDeployment>> {
    return this.request<PreviewDeployment>(
      "POST",
      `${this.workerPath(scriptName)}/previews/${encodeURIComponent(previewId)}/deployments`,
      body
    );
  }

  // ==================== Live tail ====================
  //
  // The classic tail (what `wrangler tail` uses): POST creates a short-lived
  // tail and returns a WebSocket URL speaking the "trace-v1" subprotocol.
  // Works on any Worker — no observability setting required.

  async createTail(scriptName: string): Promise<CloudflareResponse<WorkerTail>> {
    return this.request<WorkerTail>(
      "POST",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/tails`,
      {}
    );
  }

  async deleteTail(scriptName: string, tailId: string): Promise<CloudflareResponse<null>> {
    return this.request<null>(
      "DELETE",
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(
        scriptName
      )}/tails/${encodeURIComponent(tailId)}`
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
