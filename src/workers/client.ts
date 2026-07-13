/**
 * Cloudflare Workers API Client
 * Handles all HTTP communication with the Cloudflare Workers API
 */

import { TokenBucketRateLimiter } from "../utils/rate-limiter.js";
import type {
  CloudflareResponse,
  WorkerScript,
  WorkerScriptSettings,
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
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>
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
      Authorization: `Bearer ${this.apiToken}`,
    };
    if (body !== undefined && !isForm) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

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
          [{ code: 0, message: "Request timed out after 30 seconds" }],
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
