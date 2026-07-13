import { test } from "node:test";
import assert from "node:assert/strict";

import { formatError, formatSuccess } from "../../src/utils/errors.js";
import { CloudflareAPIError } from "../../src/workers/client.js";
import { RateLimitError } from "../../src/utils/rate-limiter.js";

test("formatSuccess includes the message when provided", () => {
  const data = { id: "w1" };
  const result = formatSuccess(data, "msg");
  assert.deepEqual(result, { success: true, message: "msg", data });
});

test("formatSuccess omits the message key when no message arg is passed", () => {
  const data = { id: "w1" };
  const result = formatSuccess(data);
  assert.equal(result.success, true);
  assert.equal(result.data, data);
  assert.equal("message" in result, false);
});

test("formatError handles RateLimitError", () => {
  const result = formatError(new RateLimitError("slow down"));
  assert.equal(result.error, true);
  assert.equal(result.code, "RATE_LIMIT_ERROR");
  assert.equal(result.message, "slow down");
  assert.ok(result.suggestion && result.suggestion.length > 0);
});

test("formatError handles single-error CloudflareAPIError (7000 not found)", () => {
  const result = formatError(new CloudflareAPIError([{ code: 7000, message: "not found" }], 404));
  assert.equal(result.error, true);
  assert.equal(result.code, "CF_7000");
  assert.equal(result.message, "[7000] not found");
  assert.equal(result.details, undefined);
  assert.ok(result.suggestion?.includes("list_workers"));
});

test("formatError uses the first error code and newline-joined details for multi-error", () => {
  const result = formatError(
    new CloudflareAPIError([
      { code: 9999, message: "a" },
      { code: 8888, message: "b" },
    ])
  );
  assert.equal(result.code, "CF_9999");
  assert.equal(result.details, "[9999] a\n[8888] b");
});

test("formatError code 6003 suggests a malformed Authorization header", () => {
  const result = formatError(new CloudflareAPIError([{ code: 6003, message: "bad header" }], 400));
  assert.equal(result.code, "CF_6003");
  assert.ok(result.suggestion?.includes("Authorization header is malformed"));
});

test("formatError code 10000 suggests an authentication/expired token issue", () => {
  const result = formatError(new CloudflareAPIError([{ code: 10000, message: "auth fail" }], 403));
  assert.equal(result.code, "CF_10000");
  assert.ok(result.suggestion?.includes("Authentication failed"));
  assert.ok(result.suggestion?.includes("expired"));
});

test("formatError code 9109 suggests Workers Scripts: Edit permission / account access", () => {
  const result = formatError(new CloudflareAPIError([{ code: 9109, message: "no access" }], 403));
  assert.equal(result.code, "CF_9109");
  assert.ok(result.suggestion?.includes("Workers Scripts: Edit"));
  assert.ok(result.suggestion?.includes("CLOUDFLARE_ACCOUNT_ID"));
});

test("formatError suggests a different name when the message includes 'already exists'", () => {
  const result = formatError(
    new CloudflareAPIError([{ code: 1234, message: "A Worker with this name already exists" }], 409)
  );
  assert.ok(result.suggestion?.includes("Choose a different name"));
});

test("formatError handles a plain Error", () => {
  const result = formatError(new Error("boom"));
  assert.equal(result.error, true);
  assert.equal(result.code, "INTERNAL_ERROR");
  assert.equal(result.message, "boom");
});

test("formatError handles a non-Error value", () => {
  const result = formatError("a plain string");
  assert.equal(result.error, true);
  assert.equal(result.code, "UNKNOWN_ERROR");
  assert.equal(result.message, "a plain string");
});
