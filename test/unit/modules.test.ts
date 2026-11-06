/**
 * Unit tests for module loading (issue #1): inline content vs local file
 * path, name and content-type inference, and the guards that stop a wrong
 * input from being deployed as source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentTypeForPath, loadModules } from "../../src/workers/modules.js";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cf-mcp-modules-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("inline content keeps today's behavior: name required, ES module by default", async () => {
  const loaded = await loadModules([{ name: "index.js", content: "export default {}" }]);
  assert.equal(loaded.mainModule, "index.js");
  assert.deepEqual(loaded.modules, [
    { name: "index.js", content_type: "application/javascript+module", content_base64: b64("export default {}") },
  ]);
});

test("path reads the file server-side, names it by basename and infers its type", async () => {
  await withDir(async (dir) => {
    const src = "export default { fetch() { return new Response('from disk') } }";
    await writeFile(join(dir, "worker.mjs"), src);
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await writeFile(join(dir, "add.wasm"), wasm);

    const loaded = await loadModules([{ path: join(dir, "worker.mjs") }, { path: join(dir, "add.wasm") }]);
    assert.equal(loaded.mainModule, "worker.mjs");
    assert.deepEqual(loaded.names, ["worker.mjs", "add.wasm"]);
    assert.equal(loaded.modules[0].content_base64, b64(src));
    assert.equal(loaded.modules[0].content_type, "application/javascript+module");
    assert.equal(loaded.modules[1].content_type, "application/wasm");
    assert.equal(loaded.modules[1].content_base64, b64(wasm), "binary content survives byte-for-byte");
  });
});

test("an explicit name and content_type override the inferred ones", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "bundle.out"), "module.exports = {}");
    const loaded = await loadModules([
      { path: join(dir, "bundle.out"), name: "index.cjs", content_type: "application/javascript" },
    ]);
    assert.deepEqual(
      { name: loaded.modules[0].name, type: loaded.modules[0].content_type },
      { name: "index.cjs", type: "application/javascript" }
    );
  });
});

test("content that is just a path to an existing file is refused with a hint (issue #1 repro 2)", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "worker.js");
    await writeFile(file, "export default {}");
    await assert.rejects(loadModules([{ name: "worker.js", content: file }]), /Pass it as "path" instead of "content"/);
  });
});

test("ordinary inline source that starts with a slash is not mistaken for a path", async () => {
  const content = "/regex/.test('x'); export default {}";
  const loaded = await loadModules([{ name: "index.js", content }]);
  assert.equal(loaded.modules[0].content_base64, b64(content));
});

test("missing files, directories and unbundled TypeScript fail before any upload", async () => {
  await withDir(async (dir) => {
    await assert.rejects(loadModules([{ path: join(dir, "nope.js") }]), /Module file not found/);
    await mkdir(join(dir, "sub"));
    await assert.rejects(loadModules([{ path: join(dir, "sub") }]), /not a file/);
    await writeFile(join(dir, "index.ts"), "export default {}");
    await assert.rejects(loadModules([{ path: join(dir, "index.ts") }]), /Bundle it to JavaScript first/);
  });
});

test("duplicate names and an unknown main_module are rejected", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(join(dir, "a", "index.js"), "1");
    await writeFile(join(dir, "b", "index.js"), "2");
    await assert.rejects(
      loadModules([{ path: join(dir, "a", "index.js") }, { path: join(dir, "b", "index.js") }]),
      /Two modules are named "index.js"/
    );
    await assert.rejects(
      loadModules([{ name: "index.js", content: "x" }], "main.js"),
      /main_module "main.js" does not match/
    );
  });
});

test("contentTypeForPath follows wrangler's default module rules", () => {
  assert.equal(contentTypeForPath("a.js"), "application/javascript+module");
  assert.equal(contentTypeForPath("a.CJS"), "application/javascript");
  assert.equal(contentTypeForPath("a.py"), "text/x-python");
  assert.equal(contentTypeForPath("a.html"), "text/plain");
  assert.equal(contentTypeForPath("a.bin"), "application/octet-stream");
  assert.equal(contentTypeForPath("noext"), "application/javascript+module");
});
