/**
 * Error handling utilities for MCP tool responses
 */

import { CloudflareAPIError } from "../workers/client.js";
import { RateLimitError } from "./rate-limiter.js";

export interface ToolErrorResponse {
  error: true;
  code: string;
  message: string;
  details?: string;
  suggestion?: string;
}

/**
 * Format an error for MCP tool response
 */
export function formatError(error: unknown): ToolErrorResponse {
  if (error instanceof RateLimitError) {
    return {
      error: true,
      code: "RATE_LIMIT_ERROR",
      message: error.message,
      suggestion: "Too many requests. Wait a moment before retrying.",
    };
  }

  if (error instanceof CloudflareAPIError) {
    return {
      error: true,
      code: `CF_${error.errors[0]?.code || "UNKNOWN"}`,
      message: error.message,
      details: error.errors.length > 1
        ? error.errors.map((e) => `[${e.code}] ${e.message}`).join("\n")
        : undefined,
      suggestion: getSuggestionForError(error),
    };
  }

  if (error instanceof Error) {
    return {
      error: true,
      code: "INTERNAL_ERROR",
      message: error.message,
    };
  }

  return {
    error: true,
    code: "UNKNOWN_ERROR",
    message: String(error),
  };
}

/**
 * Get helpful suggestions based on error type.
 *
 * Workers-specific error codes get added here as they are observed while the
 * tool surface grows (the codes below are shared platform-auth codes carried
 * over from cloudflare-pages-mcp, where they were verified in production).
 */
function getSuggestionForError(error: CloudflareAPIError): string | undefined {
  const errorCode = error.errors[0]?.code;
  const errorMessage = error.errors[0]?.message?.toLowerCase() || "";

  // Authentication errors

  // 6003 / 6111: the Authorization header itself is malformed (e.g. stray
  // whitespace/newlines, or "Bearer " prefix issues), not a permissions problem.
  if (errorCode === 6003 || errorCode === 6111) {
    return "The Authorization header is malformed. Check CLOUDFLARE_API_TOKEN has no stray spaces or newlines and is a valid API token (not a Global API Key).";
  }

  // 10000: generic authentication failure — bad/expired token.
  if (errorCode === 10000 || errorMessage.includes("invalid api key") || errorMessage.includes("authentication")) {
    return "Authentication failed. Check that your CLOUDFLARE_API_TOKEN is correct and has not expired.";
  }

  // 9109: token is valid but lacks access to the requested resource/account.
  if (errorCode === 9109 || errorMessage.includes("permission") || errorMessage.includes("unauthorized to access")) {
    return "Your API token cannot access this resource. Ensure it has the 'Workers Scripts: Edit' permission and includes the correct account (CLOUDFLARE_ACCOUNT_ID).";
  }

  // 100343: assets.base_path is still gated per account (observed 2026-11-05).
  if (errorCode === 100343 || errorMessage.includes("base_path is not enabled")) {
    return "A non-root base_path isn't enabled for this Cloudflare account yet. Deploy without base_path (serves at '/'), or route a path prefix to a Worker instead.";
  }

  // 10215: secret edits are refused while the newest version isn't the
  // deployed one, e.g. after rollback_worker or a staged create_version
  // (observed 2026-11-06).
  if (errorCode === 10215) {
    return "The Worker's newest version isn't the deployed one (for example after a rollback or a staged create_version), so Cloudflare blocks secret edits. Deploy the newest version with create_deployment, or redeploy the code with deploy_worker, then retry.";
  }

  // Not found errors
  if (errorCode === 7000 || errorMessage.includes("not found")) {
    return "The requested resource was not found. Use list_workers to find valid Worker names.";
  }

  // Naming/creation errors
  if (errorMessage.includes("already exists")) {
    return "A Worker with this name already exists. Choose a different name or update the existing Worker.";
  }

  if (errorMessage.includes("script name")) {
    return "Worker names must be lowercase, can only contain alphanumeric characters and hyphens, and cannot start or end with a hyphen.";
  }

  // Custom domain errors
  if (errorMessage.includes("domain") && errorMessage.includes("already")) {
    return "This custom domain is already attached to another Worker or service. Detach it there first.";
  }

  if (errorMessage.includes("zone")) {
    return "Workers custom domains require the domain's zone to be active in this Cloudflare account.";
  }

  // Rate limiting
  if (error.statusCode === 429) {
    return "Rate limit exceeded. Wait a moment before making more requests.";
  }

  return undefined;
}

/**
 * Format a successful result for consistent MCP output
 */
export function formatSuccess<T>(data: T, message?: string): {
  success: true;
  message?: string;
  data: T;
} {
  return {
    success: true,
    ...(message && { message }),
    data,
  };
}
