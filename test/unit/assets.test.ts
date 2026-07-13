/**
 * Unit tests for the static-asset pipeline: manifest hashing, directory
 * walking (exclusions, limits, symlink containment), and the upload-session
 * flow against a mocked fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_FILE_SIZE,
  buildManifest,
  collectAssets,
  contentTypeFor,
  hashAsset,
  uploadAssets,
} from "../../src/workers/assets.js";
import { WorkersClient } from "../../src/workers/client.js";
import { installMockFetch, cfOk } from "../helpers/mock-fetch.js";

const ACCOUNT = "acct-123";

async function makeSiteDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-assets-"));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  await mkdir(join(dir, "css"));
  await writeFile(join(dir, "css", "style.css"), "body{}");
  return dir;
}

test("hashAsset implements the documented formula: sha256(base64(content) + ext) first 32 hex", () => {
  const content = Buffer.from("<h1>hi</h1>");
  const expected = createHash("sha256")
    .update(content.toString("base64") + "html")
    .digest("hex")
    .slice(0, 32);

  assert.equal(hashAsset(content, "/index.html"), expected);
  assert.equal(hashAsset(content, "/index.html").length, 32);
  // The extension participates in the hash: same bytes, different ext → different hash.
  assert.notEqual(hashAsset(content, "/index.txt"), expected);
  // Extension-less files hash with an empty extension string.
  const bareExpected = createHash("sha256")
    .update(content.toString("base64"))
    .digest("hex")
    .slice(0, 32);
  assert.equal(hashAsset(content, "/LICENSE"), bareExpected);
});

test("contentTypeFor maps common extensions and defaults to octet-stream", () => {
  assert.equal(contentTypeFor("/index.html"), "text/html");
  assert.equal(contentTypeFor("/app.JS"), "text/javascript");
  assert.equal(contentTypeFor("/font.woff2"), "font/woff2");
  assert.equal(contentTypeFor("/data.unknownext"), "application/octet-stream");
  assert.equal(contentTypeFor("/noext"), "application/octet-stream");
});

test("collectAssets walks nested dirs and builds leading-slash manifest paths", async () => {
  const dir = await makeSiteDir();
  try {
    const { files, headers, redirects } = await collectAssets(dir);

    assert.deepEqual(files.map((f) => f.path).sort(), ["/css/style.css", "/index.html"]);
    assert.equal(headers, undefined);
    assert.equal(redirects, undefined);

    const manifest = buildManifest(files);
    assert.deepEqual(Object.keys(manifest).sort(), ["/css/style.css", "/index.html"]);
    assert.equal(manifest["/index.html"].size, Buffer.byteLength("<h1>hi</h1>"));
    assert.match(manifest["/index.html"].hash, /^[0-9a-f]{32}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets reads _headers/_redirects as config and excludes them from the manifest", async () => {
  const dir = await makeSiteDir();
  try {
    await writeFile(join(dir, "_headers"), "/dashboard/*\n  X-Frame-Options: DENY");
    await writeFile(join(dir, "_redirects"), "/old /new 301");
    await writeFile(join(dir, ".assetsignore"), "_worker.js");

    const { files, headers, redirects } = await collectAssets(dir);

    assert.deepEqual(files.map((f) => f.path).sort(), ["/css/style.css", "/index.html"]);
    assert.match(headers ?? "", /X-Frame-Options/);
    assert.equal(redirects, "/old /new 301");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets rejects an empty or missing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-empty-"));
  try {
    await assert.rejects(() => collectAssets(dir), /No files found/);
    await assert.rejects(() => collectAssets(join(dir, "nope")), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets rejects files over the 25 MiB limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-big-"));
  try {
    await writeFile(join(dir, "huge.bin"), Buffer.alloc(MAX_FILE_SIZE + 1));
    await assert.rejects(() => collectAssets(dir), /25 MiB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets rejects symlinks that escape the asset root and follows ones inside it", async () => {
  const outside = await mkdtemp(join(tmpdir(), "cf-mcp-outside-"));
  const dir = await makeSiteDir();
  try {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(dir, "leak.txt"));
    await assert.rejects(() => collectAssets(dir), /outside the asset directory/);

    await rm(join(dir, "leak.txt"));
    await symlink(join(dir, "index.html"), join(dir, "alias.html"));
    const { files } = await collectAssets(dir);
    assert.ok(files.some((f) => f.path === "/alias.html"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("uploadAssets uploads requested buckets with the session JWT and returns the completion JWT", async () => {
  const dir = await makeSiteDir();
  const mock = installMockFetch();
  try {
    const { files } = await collectAssets(dir);
    const [cssFile, htmlFile] = [...files].sort((a, b) => a.path.localeCompare(b.path));

    // Session: server already has the css file, wants the html in one bucket.
    mock.enqueue(cfOk({ jwt: "session-jwt", buckets: [[htmlFile.hash]] }));
    // Bucket upload completes the manifest → 201 with the completion JWT.
    mock.enqueue({ status: 201, json: { success: true, errors: [], messages: [], result: { jwt: "completion-jwt" } } });

    const client = new WorkersClient("test-token", ACCOUNT);
    const result = await uploadAssets(client, "my-site", files);

    assert.deepEqual(result, { completionJwt: "completion-jwt", uploaded: 1, skipped: 1 });

    // Session call: normal API token, manifest body.
    assert.match(mock.calls[0].url, /\/workers\/scripts\/my-site\/assets-upload-session$/);
    assert.equal(mock.calls[0].headers.Authorization, "Bearer test-token");
    const sessionBody = JSON.parse(mock.calls[0].body as string) as { manifest: Record<string, unknown> };
    assert.deepEqual(Object.keys(sessionBody.manifest).sort(), ["/css/style.css", "/index.html"]);

    // Bucket call: session JWT bearer, base64=true, field name = hash, base64 content.
    const bucketCall = mock.calls[1];
    assert.match(bucketCall.url, /\/workers\/assets\/upload\?base64=true$/);
    assert.equal(bucketCall.headers.Authorization, "Bearer session-jwt");
    assert.ok(bucketCall.body instanceof FormData);
    const form = bucketCall.body as FormData;
    const part = form.get(htmlFile.hash);
    assert.ok(part instanceof File, "part should be a File keyed by the file hash");
    assert.equal(await part.text(), Buffer.from("<h1>hi</h1>").toString("base64"));
    assert.equal(part.type, "text/html");
    assert.equal(form.get(cssFile.hash), null, "deduped file must not be uploaded");
  } finally {
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploadAssets empty-bucket fast path: session JWT doubles as the completion token", async () => {
  const dir = await makeSiteDir();
  const mock = installMockFetch();
  try {
    const { files } = await collectAssets(dir);
    mock.enqueue(cfOk({ jwt: "session-as-completion", buckets: [] }));

    const client = new WorkersClient("test-token", ACCOUNT);
    const result = await uploadAssets(client, "my-site", files);

    assert.deepEqual(result, { completionJwt: "session-as-completion", uploaded: 0, skipped: 2 });
    assert.equal(mock.calls.length, 1, "no bucket uploads should happen");
  } finally {
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploadAssets fails clearly when no completion JWT ever arrives", async () => {
  const dir = await makeSiteDir();
  const mock = installMockFetch();
  try {
    const { files } = await collectAssets(dir);
    mock.enqueue(cfOk({ jwt: "session-jwt", buckets: [[files[0].hash]] }));
    // Intermediate-style response (202, no jwt) even though it was the only bucket.
    mock.enqueue({ status: 202, json: { success: true, errors: [], messages: [], result: {} } });

    const client = new WorkersClient("test-token", ACCOUNT);
    await assert.rejects(() => uploadAssets(client, "my-site", files), /no completion token/);
  } finally {
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
