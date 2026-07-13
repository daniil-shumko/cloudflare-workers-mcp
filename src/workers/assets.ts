/**
 * Static-asset direct upload: directory walking, manifest hashing, and the
 * upload-session/bucket flow (IMPLEMENTATION_PLAN.md §3, verified against the
 * live docs and OpenAPI schema 2026-07-13).
 */

import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import type { WorkersClient } from "./client.js";
import type { AssetManifest } from "./types.js";

/** Cloudflare per-file limit: 25 MiB. */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Hard per-version file-count cap (paid plan); free plans cap at 20,000. */
export const MAX_FILE_COUNT = 100_000;
export const FREE_PLAN_FILE_COUNT = 20_000;

/**
 * Files that are configuration, not content: read (where meaningful) and
 * excluded from the manifest — uploading them would serve the raw rule files
 * publicly and apply none of the rules.
 */
const CONFIG_FILES = new Set(["_headers", "_redirects", ".assetsignore"]);

export interface AssetFile {
  /** Manifest path: root-relative, leading slash, forward slashes. */
  path: string;
  /** Absolute filesystem path. */
  filePath: string;
  size: number;
  hash: string;
  contentType: string;
}

export interface CollectedAssets {
  files: AssetFile[];
  /** Contents of `_headers` at the asset root, when present. */
  headers?: string;
  /** Contents of `_redirects` at the asset root, when present. */
  redirects?: string;
}

/**
 * The documented manifest hash: first 32 hex chars of SHA-256 over
 * base64(fileContent) + fileExtensionWithoutDot. NOT a hash of the raw bytes.
 */
export function hashAsset(content: Buffer, relativePath: string): string {
  const extension = extname(relativePath).substring(1);
  return createHash("sha256")
    .update(content.toString("base64") + extension)
    .digest("hex")
    .slice(0, 32);
}

// Extension → Content-Type served with the asset. The part Content-Type sent
// during upload is stored by Cloudflare and attached at serve time.
const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  csv: "text/csv",
  yaml: "text/yaml",
  yml: "text/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  map: "application/json",
  webmanifest: "application/manifest+json",
  zip: "application/zip",
  gz: "application/gzip",
};

export function contentTypeFor(path: string): string {
  const extension = extname(path).substring(1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Walk `rootDir` and build the upload list. Rejects (throws) on: a missing or
 * empty directory, files over 25 MiB, more than 100k files, and symlinks that
 * escape the root. Non-regular files (sockets, fifos) are skipped. `_headers`
 * and `_redirects` at the root are read into strings and excluded from the
 * manifest, along with `.assetsignore` (not parsed — v1 uploads everything else).
 */
export async function collectAssets(rootDir: string): Promise<CollectedAssets> {
  const root = await realpath(resolve(rootDir)).catch(() => {
    throw new Error(`Asset directory not found: ${rootDir}`);
  });

  const files: AssetFile[] = [];
  let headers: string | undefined;
  let redirects: string | undefined;

  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      const relPath = `${relPrefix}/${entry.name}`;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Follow the link but refuse anything that escapes the asset root —
        // a deploy must never leak files from outside the chosen directory.
        const target = await realpath(filePath).catch(() => null);
        if (!target || (target !== root && !target.startsWith(root + sep))) {
          throw new Error(
            `Refusing to deploy symlink that points outside the asset directory: ${relPath}`
          );
        }
        const stat = await lstat(target);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      }

      if (isDir) {
        await walk(filePath, relPath);
        continue;
      }
      if (!isFile) continue; // sockets, fifos, devices

      if (relPrefix === "" && CONFIG_FILES.has(entry.name)) {
        if (entry.name === "_headers") headers = await readFile(filePath, "utf8");
        if (entry.name === "_redirects") redirects = await readFile(filePath, "utf8");
        continue;
      }

      const content = await readFile(filePath);
      if (content.length > MAX_FILE_SIZE) {
        throw new Error(
          `${relPath} is ${(content.length / (1024 * 1024)).toFixed(1)} MiB — Cloudflare limits static assets to 25 MiB per file.`
        );
      }

      files.push({
        path: relPath,
        filePath,
        size: content.length,
        hash: hashAsset(content, relPath),
        contentType: contentTypeFor(relPath),
      });

      if (files.length > MAX_FILE_COUNT) {
        throw new Error(
          `More than ${MAX_FILE_COUNT.toLocaleString()} files in ${rootDir} — Cloudflare limits a Worker version to ${MAX_FILE_COUNT.toLocaleString()} assets (${FREE_PLAN_FILE_COUNT.toLocaleString()} on the free plan).`
        );
      }
    }
  }

  await walk(root, "");

  if (files.length === 0) {
    throw new Error(`No files found in asset directory: ${rootDir}`);
  }

  return { files, headers, redirects };
}

export function buildManifest(files: AssetFile[]): AssetManifest {
  const manifest: AssetManifest = {};
  for (const file of files) {
    manifest[file.path] = { hash: file.hash, size: file.size };
  }
  return manifest;
}

export interface UploadResult {
  /** Completion JWT to redeem in the script upload's metadata.assets.jwt. */
  completionJwt: string;
  uploaded: number;
  /** Files the server already had (deduped across deploys). */
  skipped: number;
}

/**
 * Run the upload-session flow: create a session for the manifest, upload each
 * bucket the server asks for (multipart, base64, authorized by the session
 * JWT), and return the completion JWT. When the server already has every file,
 * the session JWT doubles as the completion token and nothing is uploaded.
 * Completion is detected by the presence of `jwt` in a bucket response (HTTP
 * 201) — not by bucket order.
 */
export async function uploadAssets(
  client: WorkersClient,
  scriptName: string,
  files: AssetFile[]
): Promise<UploadResult> {
  const manifest = buildManifest(files);
  const session = await client.createAssetUploadSession(scriptName, manifest);
  const sessionJwt = session.result?.jwt;
  const buckets = session.result?.buckets ?? [];

  if (!sessionJwt) {
    throw new Error(
      "Cloudflare did not return an upload-session token — cannot continue the asset upload."
    );
  }

  if (buckets.length === 0) {
    // Every file already uploaded previously; the session JWT is the completion token.
    return { completionJwt: sessionJwt, uploaded: 0, skipped: files.length };
  }

  const byHash = new Map(files.map((f) => [f.hash, f]));
  let completionJwt: string | undefined;
  let uploaded = 0;

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) {
        throw new Error(
          `Upload session asked for unknown file hash ${hash} — the directory may have changed mid-deploy; retry.`
        );
      }
      const base64 = (await readFile(file.filePath)).toString("base64");
      form.append(hash, new File([base64], file.path.slice(1), { type: file.contentType }));
      uploaded += 1;
    }
    const response = await client.uploadAssetBucket(sessionJwt, form);
    if (response.result?.jwt) {
      completionJwt = response.result.jwt;
    }
  }

  if (!completionJwt) {
    throw new Error(
      "Asset upload finished but Cloudflare returned no completion token — the session may have expired (tokens live 1 hour); retry the deploy."
    );
  }

  return { completionJwt, uploaded, skipped: files.length - uploaded };
}
