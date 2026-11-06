/**
 * Worker module sources for deploy_worker / create_version / deploy_preview.
 *
 * A module comes either inline (`content`) or from a local file (`path`). The
 * file form keeps large or bundled sources out of the MCP client's context and
 * also carries binary modules (WebAssembly, data) that a string can't.
 */

import { stat, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";

import type { VersionModule } from "./types.js";

export interface ModuleSpec {
  name?: string;
  content?: string;
  path?: string;
  content_type?: string;
}

export interface LoadedModules {
  modules: VersionModule[];
  names: string[];
  mainModule: string;
}

/** Above this a file is almost certainly not a Worker module (Cloudflare caps Workers at 10 MB compressed). */
export const MAX_MODULE_FILE_BYTES = 64 * 1024 * 1024;

const ESM = "application/javascript+module";

/**
 * Module types by extension, following wrangler's default module rules.
 * Unknown extensions fall back to an ES module, like inline content does.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": ESM,
  ".mjs": ESM,
  ".cjs": "application/javascript",
  ".py": "text/x-python",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".html": "text/plain",
  ".sql": "text/plain",
  ".bin": "application/octet-stream",
  ".map": "application/source-map",
};

const NEEDS_BUNDLING = new Set([".ts", ".mts", ".cts", ".tsx", ".jsx"]);

export function contentTypeForPath(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? ESM;
}

/**
 * Inline content that is just an absolute path to an existing file was almost
 * certainly meant as `path`. Uploading it would deploy the path string as
 * source and fail with a confusing syntax error.
 */
function looksLikeFilePath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === "" || trimmed.includes("\n") || !isAbsolute(trimmed)) return false;
  try {
    return statSync(trimmed).isFile();
  } catch {
    return false;
  }
}

async function readModuleFile(path: string): Promise<Buffer> {
  const full = resolve(path);
  const info = await stat(full).catch(() => {
    throw new Error(`Module file not found: ${path}`);
  });
  if (!info.isFile()) throw new Error(`Module path is not a file: ${path}`);
  if (info.size > MAX_MODULE_FILE_BYTES) {
    throw new Error(
      `Module file ${path} is ${(info.size / 1024 / 1024).toFixed(1)} MB, far over Cloudflare's Worker size limit (10 MB compressed). Bundle and minify it first.`
    );
  }
  return readFile(full);
}

/**
 * Resolve module specs into version modules (base64) and pick the entry
 * point. Throws a descriptive Error for any problem before anything is sent
 * to Cloudflare.
 */
export async function loadModules(specs: ModuleSpec[], mainModule?: string): Promise<LoadedModules> {
  const modules: VersionModule[] = [];
  for (const [i, spec] of specs.entries()) {
    const label = spec.name ?? spec.path ?? `modules[${i}]`;
    let bytes: Buffer;
    let name: string;
    let contentType = spec.content_type;

    if (spec.path !== undefined) {
      const ext = extname(spec.path).toLowerCase();
      if (NEEDS_BUNDLING.has(ext) && !contentType) {
        throw new Error(
          `${spec.path} is ${ext === ".jsx" ? "JSX" : "TypeScript"}, which Workers can't run directly. Bundle it to JavaScript first (e.g. \`npx wrangler deploy --dry-run --outdir dist\` or esbuild) and pass the bundled .js file.`
        );
      }
      bytes = await readModuleFile(spec.path);
      name = spec.name ?? basename(spec.path);
      contentType ??= contentTypeForPath(spec.path);
    } else {
      const content = spec.content ?? "";
      if (looksLikeFilePath(content)) {
        throw new Error(
          `The content of module "${label}" is a file path (${content.trim()}), not source code. Pass it as "path" instead of "content" to upload the file.`
        );
      }
      if (spec.name === undefined) throw new Error(`modules[${i}] needs a name when it uses inline content.`);
      bytes = Buffer.from(content, "utf8");
      name = spec.name;
      contentType ??= ESM;
    }
    modules.push({ name, content_type: contentType, content_base64: bytes.toString("base64") });
  }

  const names = modules.map((m) => m.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) {
    throw new Error(`Two modules are named "${duplicate}". Module names must be unique; set "name" to tell them apart.`);
  }
  const main = mainModule ?? names[0];
  if (!names.includes(main)) {
    throw new Error(`main_module "${main}" does not match any provided module name (${names.join(", ")}).`);
  }
  return { modules, names, mainModule: main };
}
