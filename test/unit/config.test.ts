import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, ConfigurationError } from "../../src/utils/config.js";

const TOKEN_KEY = "CLOUDFLARE_API_TOKEN";
const ACCOUNT_KEY = "CLOUDFLARE_ACCOUNT_ID";

let savedToken: string | undefined;
let savedAccount: string | undefined;

beforeEach(() => {
  savedToken = process.env[TOKEN_KEY];
  savedAccount = process.env[ACCOUNT_KEY];
});

afterEach(() => {
  // Restore the two env vars so tests never leak state into each other.
  if (savedToken === undefined) delete process.env[TOKEN_KEY];
  else process.env[TOKEN_KEY] = savedToken;
  if (savedAccount === undefined) delete process.env[ACCOUNT_KEY];
  else process.env[ACCOUNT_KEY] = savedAccount;
});

test("throws ConfigurationError mentioning CLOUDFLARE_API_TOKEN when token is missing", () => {
  delete process.env[TOKEN_KEY];
  process.env[ACCOUNT_KEY] = "acct";

  assert.throws(
    () => loadConfig(),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.equal((err as Error).name, "ConfigurationError");
      assert.match((err as Error).message, /CLOUDFLARE_API_TOKEN/);
      return true;
    }
  );
});

test("throws ConfigurationError mentioning CLOUDFLARE_ACCOUNT_ID when token present but account missing", () => {
  process.env[TOKEN_KEY] = "tok";
  delete process.env[ACCOUNT_KEY];

  assert.throws(
    () => loadConfig(),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.equal((err as Error).name, "ConfigurationError");
      assert.match((err as Error).message, /CLOUDFLARE_ACCOUNT_ID/);
      return true;
    }
  );
});

test("treats whitespace-only token as missing", () => {
  process.env[TOKEN_KEY] = "   \n\t";
  process.env[ACCOUNT_KEY] = "acct";

  assert.throws(
    () => loadConfig(),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /CLOUDFLARE_API_TOKEN/);
      return true;
    }
  );
});

test("trims surrounding whitespace/newlines from both values", () => {
  process.env[TOKEN_KEY] = "  tok\n";
  process.env[ACCOUNT_KEY] = "\tacct ";

  const config = loadConfig();
  assert.deepEqual(config, { apiToken: "tok", accountId: "acct" });
});

test("returns exact values when both are present and clean", () => {
  process.env[TOKEN_KEY] = "my-token-123";
  process.env[ACCOUNT_KEY] = "my-account-456";

  const config = loadConfig();
  assert.equal(config.apiToken, "my-token-123");
  assert.equal(config.accountId, "my-account-456");
  assert.deepEqual(config, { apiToken: "my-token-123", accountId: "my-account-456" });
});
