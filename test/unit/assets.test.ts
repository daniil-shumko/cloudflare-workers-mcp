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
  isIgnored,
  parseAssetsIgnore,
  uploadAssets,
} from "../../src/workers/assets.js";
import { WorkersClient, bucketUploadTimeoutMs } from "../../src/workers/client.js";
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

    const { files, headers, redirects, hasAssetsIgnore, ignoredCount } = await collectAssets(dir);

    assert.deepEqual(files.map((f) => f.path).sort(), ["/css/style.css", "/index.html"]);
    assert.match(headers ?? "", /X-Frame-Options/);
    assert.equal(redirects, "/old /new 301");
    assert.equal(hasAssetsIgnore, true);
    assert.equal(ignoredCount, 0, "no file matches _worker.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseAssetsIgnore/isIgnored implement the gitignore-style subset", () => {
  const rules = parseAssetsIgnore(
    [
      "# comment",
      "",
      "secrets/",
      "*.map",
      "!keep.map",
      "/root-only.txt",
      "docs/*.md",
      "**/tmp",
    ].join("\n")
  );

  // Directory rule: matches the dir at any depth, not files.
  assert.equal(isIgnored(rules, "secrets", true), true);
  assert.equal(isIgnored(rules, "a/secrets", true), true);
  assert.equal(isIgnored(rules, "secrets", false), false);
  // Glob at any depth, with a negation that wins by order.
  assert.equal(isIgnored(rules, "app.js.map", false), true);
  assert.equal(isIgnored(rules, "js/app.js.map", false), true);
  assert.equal(isIgnored(rules, "keep.map", false), false);
  // Leading slash anchors to the root.
  assert.equal(isIgnored(rules, "root-only.txt", false), true);
  assert.equal(isIgnored(rules, "sub/root-only.txt", false), false);
  // A pattern with an inner slash is root-anchored; * stays within a segment.
  assert.equal(isIgnored(rules, "docs/readme.md", false), true);
  assert.equal(isIgnored(rules, "docs/sub/readme.md", false), false);
  assert.equal(isIgnored(rules, "other/docs/readme.md", false), false);
  // A full ** segment matches ZERO or more segments (gitignore semantics).
  assert.equal(isIgnored(rules, "a/b/tmp", false), true);
  assert.equal(isIgnored(rules, "tmp", false), true);

  const zeroSeg = parseAssetsIgnore("a/**/b\nc/**");
  assert.equal(isIgnored(zeroSeg, "a/b", false), true);
  assert.equal(isIgnored(zeroSeg, "a/x/y/b", false), true);
  assert.equal(isIgnored(zeroSeg, "a/xb", false), false);
  // Trailing /** matches everything inside, not the directory path itself.
  assert.equal(isIgnored(zeroSeg, "c/deep/file.txt", false), true);
  assert.equal(isIgnored(zeroSeg, "c", false), false);
});

test("collectAssets skips ignored entries before symlink checks — an ignored out-of-root symlink can't abort the deploy", async () => {
  const outside = await mkdtemp(join(tmpdir(), "cf-mcp-outside-ign-"));
  const dir = await makeSiteDir();
  try {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(dir, "leak.txt"));
    await symlink(join(dir, "missing-target"), join(dir, "broken.txt"));
    await writeFile(join(dir, ".assetsignore"), "leak.txt\nbroken.txt");

    const { files, ignoredCount } = await collectAssets(dir);

    assert.deepEqual(files.map((f) => f.path).sort(), ["/css/style.css", "/index.html"]);
    assert.equal(ignoredCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("collectAssets applies .assetsignore rules and reports the excluded count", async () => {
  const dir = await makeSiteDir();
  try {
    await mkdir(join(dir, "secrets"));
    await writeFile(join(dir, "secrets", "api-key.txt"), "shh");
    await writeFile(join(dir, "app.js.map"), "{}");
    await writeFile(join(dir, "keep.map"), "{}");
    await writeFile(join(dir, ".assetsignore"), "secrets/\n*.map\n!keep.map");

    const { files, hasAssetsIgnore, ignoredCount } = await collectAssets(dir);

    assert.equal(hasAssetsIgnore, true);
    assert.deepEqual(files.map((f) => f.path).sort(), [
      "/css/style.css",
      "/index.html",
      "/keep.map",
    ]);
    // app.js.map is counted; secrets/ was skipped as a whole directory.
    assert.equal(ignoredCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets rejects directory-symlink cycles with a clear error", async () => {
  const dir = await makeSiteDir();
  try {
    await symlink(dir, join(dir, "loop"));
    await assert.rejects(() => collectAssets(dir), /Symlink cycle detected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectAssets allows sibling symlinks to the same in-root directory (no cycle)", async () => {
  const dir = await makeSiteDir();
  try {
    await symlink(join(dir, "css"), join(dir, "styles"));
    const { files } = await collectAssets(dir);
    assert.deepEqual(files.map((f) => f.path).sort(), [
      "/css/style.css",
      "/index.html",
      "/styles/style.css",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bucketUploadTimeoutMs scales with payload and stays within its floor/cap", () => {
  assert.equal(bucketUploadTimeoutMs(0), 120_000);
  // 32 MiB of base64 → floor + ~328 s.
  const large = bucketUploadTimeoutMs(32 * 1024 * 1024);
  assert.ok(large > 400_000 && large < 500_000, `got ${large}`);
  assert.equal(bucketUploadTimeoutMs(10 * 1024 * 1024 * 1024), 1_800_000);
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
