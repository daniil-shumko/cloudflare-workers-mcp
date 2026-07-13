import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkersClient, CloudflareAPIError } from "../../src/workers/client.js";
import { installMockFetch, cfOk, cfErr } from "../helpers/mock-fetch.js";

const ACCOUNT = "acct-123";

function makeClient(): WorkersClient {
  return new WorkersClient("test-token", ACCOUNT);
}

test("constructor rejects missing token and account id", () => {
  assert.throws(() => new WorkersClient("", ACCOUNT), /token is required/);
  assert.throws(() => new WorkersClient("tok", ""), /account ID is required/);
});

test("listWorkers hits the scripts endpoint with a bearer token and parses the result", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(
      cfOk([
        { id: "my-site", created_on: "2026-01-01T00:00:00Z", has_assets: true },
        { id: "api-worker", has_modules: true },
      ])
    );

    const client = makeClient();
    const response = await client.listWorkers();

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, "GET");
    assert.equal(
      mock.calls[0].url,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`
    );
    assert.equal(mock.calls[0].headers.Authorization, "Bearer test-token");
    // GET requests must not claim a JSON body.
    assert.equal("Content-Type" in mock.calls[0].headers, false);

    assert.equal(response.success, true);
    assert.equal(response.result.length, 2);
    assert.equal(response.result[0].id, "my-site");
    assert.equal(response.result[0].has_assets, true);
  } finally {
    mock.restore();
  }
});

test("getWorkerSettings URL-encodes the script name and targets /settings", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfOk({ compatibility_date: "2026-01-01", bindings: [] }));

    const client = makeClient();
    const response = await client.getWorkerSettings("my worker");

    assert.equal(
      mock.calls[0].url,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/my%20worker/settings`
    );
    assert.equal(response.result.compatibility_date, "2026-01-01");
  } finally {
    mock.restore();
  }
});

test("a Cloudflare error envelope becomes a CloudflareAPIError with code and status", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue(cfErr(404, 10007, "workers.api.error.script_not_found"));

    const client = makeClient();
    await assert.rejects(
      () => client.getWorkerSettings("nope"),
      (err: unknown) => {
        assert.ok(err instanceof CloudflareAPIError);
        assert.equal(err.statusCode, 404);
        assert.deepEqual(err.errors, [{ code: 10007, message: "workers.api.error.script_not_found" }]);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

test("a non-JSON error body (edge HTML) surfaces the HTTP status, not a SyntaxError", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue({ status: 502, statusText: "Bad Gateway", text: "<html>gateway error</html>" });

    const client = makeClient();
    await assert.rejects(
      () => client.listWorkers(),
      (err: unknown) => {
        assert.ok(err instanceof CloudflareAPIError);
        assert.equal(err.statusCode, 502);
        assert.match(err.message, /gateway error/);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

test("an HTTP 200 with success:false in the envelope still throws", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueue({
      status: 200,
      json: { success: false, errors: [{ code: 9999, message: "logical failure" }], messages: [], result: null },
    });

    const client = makeClient();
    await assert.rejects(
      () => client.listWorkers(),
      (err: unknown) => {
        assert.ok(err instanceof CloudflareAPIError);
        assert.deepEqual(err.errors, [{ code: 9999, message: "logical failure" }]);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

test("verifyToken falls back to the user endpoint when the account endpoint rejects", async () => {
  const mock = installMockFetch();
  try {
    // Account-scoped verify fails (as it does for user-created tokens)…
    mock.enqueue(cfErr(403, 9109, "Unauthorized to access requested resource"));
    // …then the user-scoped verify succeeds.
    mock.enqueue(cfOk({ id: "tok-1", status: "active" }));

    const client = makeClient();
    const result = await client.verifyToken();

    assert.equal(result.valid, true);
    assert.equal(result.status, "active");
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[0].url, /\/accounts\/acct-123\/tokens\/verify$/);
    assert.match(mock.calls[1].url, /\/user\/tokens\/verify$/);
  } finally {
    mock.restore();
  }
});

test("verifyToken reports a transport failure as invalid with detail, not a throw", async () => {
  const mock = installMockFetch();
  try {
    mock.enqueueError(new Error("network down"));

    const client = makeClient();
    const result = await client.verifyToken();

    assert.equal(result.valid, false);
    assert.match(result.detail ?? "", /network down/);
  } finally {
    mock.restore();
  }
});
