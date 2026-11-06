/**
 * Guarded live e2e against a real Cloudflare account (mirrors
 * cloudflare-pages-mcp's lifecycle test): deploy a throwaway static site over
 * the real MCP stdio server, verify it serves over HTTP, exercise dedupe on
 * redeploy, then delete it — with best-effort cleanup even on failure.
 *
 * Skipped unless CF_LIVE_TEST=1 and real CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_ACCOUNT_ID are set (`npm run test:live`). Only creates resources
 * named cf-mcp-test-*.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { WorkersClient } from "../../src/workers/client.js";

const LIVE =
  process.env.CF_LIVE_TEST === "1" &&
  !!process.env.CLOUDFLARE_API_TOKEN &&
  !!process.env.CLOUDFLARE_ACCOUNT_ID;

interface ToolResult {
  isError: boolean;
  payload: {
    success?: boolean;
    message?: string;
    data?: Record<string, unknown> & {
      files_total?: number;
      files_uploaded?: number;
      files_reused?: number;
      url?: string;
      workers?: Array<{ name: string }>;
      versions?: Array<unknown>;
    };
    [key: string]: unknown;
  };
}

/** Poll a URL until it returns 200, bounded by `deadlineMs`. */
async function fetchUntilOk(url: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      lastStatus = response.status;
      if (response.ok) return await response.text();
    } catch {
      // DNS not propagated yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${url} did not serve within ${deadlineMs}ms (last status: ${lastStatus})`);
}

/** Poll a URL (any status) until its body matches, bounded by `deadlineMs`. */
async function fetchUntilBody(url: string, pattern: RegExp, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (pattern.test(await response.text())) return;
    } catch {
      // Transient — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${url} never matched ${pattern} within ${deadlineMs}ms`);
}

test(
  "live static-site lifecycle: deploy → serve → dedupe redeploy → delete",
  {
    skip: LIVE ? false : "set CF_LIVE_TEST=1 and CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID to run",
    // Generous: the sum of every serve-poll window (180/120 s each) plus deploy overhead.
    timeout: 1500000,
  },
  async () => {
    const scriptName = `cf-mcp-test-${Date.now().toString(36)}`;

    // A tiny throwaway site: nested path + 404 page + a _headers rule.
    const siteDir = await mkdtemp(join(tmpdir(), "cf-mcp-live-site-"));
    await writeFile(join(siteDir, "index.html"), `<h1>cf-mcp-test ${scriptName}</h1>`);
    await writeFile(join(siteDir, "404.html"), "<h1>custom not found</h1>");
    await mkdir(join(siteDir, "css"));
    await writeFile(join(siteDir, "css", "style.css"), "body{color:rebeccapurple}");
    await writeFile(join(siteDir, "_headers"), "/*\n  X-Cf-Mcp-Test: 1");

    // Worker modules on disk (issue #1): an entry that imports a binary .wasm,
    // which inline string content can't carry.
    const modDir = await mkdtemp(join(tmpdir(), "cf-mcp-live-mod-"));
    await writeFile(
      join(modDir, "worker.js"),
      [
        'import addWasm from "./add.wasm";',
        "const { exports } = await WebAssembly.instantiate(addWasm);",
        "export default { fetch() { return new Response('cf-mcp-test from disk 2+3=' + exports.add(2, 3)); } };",
      ].join("\n")
    );
    // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    await writeFile(
      join(modDir, "add.wasm"),
      Buffer.from(
        "0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b",
        "hex"
      )
    );

    const transport = new StdioClientTransport({
      command: "node",
      args: ["--import", "tsx", "src/index.ts"],
      env: { ...(process.env as Record<string, string>) },
    });
    const client = new Client({ name: "live", version: "0.0.0" }, { capabilities: {} });
    // Direct API client for finally-fallback cleanup; the happy path deletes
    // through the delete_worker tool.
    const direct = new WorkersClient(
      process.env.CLOUDFLARE_API_TOKEN!,
      process.env.CLOUDFLARE_ACCOUNT_ID!
    );

    const needsCleanup = new Set<string>();

    async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const result = await client.callTool({ name, arguments: args });
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { isError: !!result.isError, payload: JSON.parse(text) };
    }

    try {
      await client.connect(transport);

      // Fail fast on bad creds before creating anything.
      const health = await call("health_check", {});
      assert.equal(
        (health.payload.data as { token_valid?: boolean }).token_valid,
        true,
        "health_check failed — check the live-test credentials"
      );

      // Mark for cleanup BEFORE the deploy: a partially failed deploy can
      // still have created the script.
      needsCleanup.add(scriptName);
      const deploy = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
        not_found_handling: "404-page",
      });
      assert.equal(deploy.isError, false, `deploy failed: ${JSON.stringify(deploy.payload)}`);
      assert.equal(deploy.payload.data?.files_total, 3, "manifest should exclude _headers");
      assert.equal(deploy.payload.data?.files_uploaded, 3);

      // It should actually serve — the assets-only Worker (no main_module)
      // being valid is exactly what this live test exists to confirm (M2).
      const url = deploy.payload.data?.url;
      assert.ok(url, `expected a workers.dev URL, got: ${JSON.stringify(deploy.payload.data)}`);
      const body = await fetchUntilOk(url, 180000);
      assert.match(body, new RegExp(scriptName), "served page should be the deployed index.html");
      assert.equal((await fetch(url)).headers.get("x-cf-mcp-test"), "1", "the _headers rule should apply in production");

      // Server-side dedupe: an unchanged redeploy uploads nothing.
      const redeploy = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
      });
      assert.equal(redeploy.isError, false, `redeploy failed: ${JSON.stringify(redeploy.payload)}`);
      assert.equal(redeploy.payload.data?.files_uploaded, 0, "unchanged files should dedupe");
      assert.equal(redeploy.payload.data?.files_reused, 3);

      // Read-back through the read-only surface.
      const list = await call("list_workers", {});
      assert.ok(
        list.payload.data?.workers?.some((w) => w.name === scriptName),
        "deployed Worker should appear in list_workers"
      );
      const versions = await call("list_versions", { script_name: scriptName });
      assert.ok((versions.payload.data?.versions?.length ?? 0) >= 2, "each deploy creates a version");

      // Asset config is preserved by redeploy_assets (keep_assets). The
      // dedupe redeploy above set no not_found_handling (default: plain 404),
      // so re-apply 404-page through a zero-upload deploy_static_site, wait
      // for the custom page, then check redeploy_assets keeps it.
      const missingUrl = new URL("/does-not-exist", url).toString();
      const reconfig = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
        not_found_handling: "404-page",
      });
      assert.equal(reconfig.isError, false, `reconfig deploy failed: ${JSON.stringify(reconfig.payload)}`);
      assert.equal(reconfig.payload.data?.files_uploaded, 0, "a config-only change uploads nothing");
      await fetchUntilBody(missingUrl, /custom not found/, 180000);

      const keep = await call("redeploy_assets", { script_name: scriptName });
      assert.equal(keep.isError, false, `redeploy_assets failed: ${JSON.stringify(keep.payload)}`);
      // Give the new version time to propagate, then the config must still hold.
      await new Promise((resolve) => setTimeout(resolve, 20000));
      assert.match(
        await (await fetch(missingUrl)).text(),
        /custom not found/,
        "redeploy_assets must preserve the previous asset config"
      );
      assert.match(await fetchUntilOk(url, 60000), new RegExp(scriptName), "assets still served");
      const afterRedeploy = await call("list_versions", { script_name: scriptName });
      assert.match(
        (afterRedeploy.payload.data?.versions as Array<{ message?: string }>)[0].message ?? "",
        /Redeploy reusing assets/,
        "merge-patched versions carry an explicit message"
      );

      // A module Worker via deploy_worker, served on workers.dev. LABEL lets
      // later steps prove which version (and which bindings) is live.
      const workerName = `${scriptName}-w`;
      needsCleanup.add(workerName);
      const workerCode = (marker = "") => [
        {
          name: "index.js",
          content: [
            "export default { fetch(req, env) {",
            "  console.log('cf-mcp-test log', new URL(req.url).pathname);",
            `  return new Response('hello from cf-mcp-test worker ${marker}' + (env.LABEL ?? 'v1') + ' secret=' + (env.LIVE_SECRET ?? 'none'));`,
            "} }",
          ].join("\n"),
        },
      ];
      const deployWorker = await call("deploy_worker", { script_name: workerName, modules: workerCode() });
      assert.equal(
        deployWorker.isError,
        false,
        `deploy_worker failed: ${JSON.stringify(deployWorker.payload)}`
      );
      const workerUrl = deployWorker.payload.data?.url;
      assert.ok(workerUrl, "expected a workers.dev URL for the module Worker");
      const workerBody = await fetchUntilOk(workerUrl, 180000);
      assert.match(workerBody, /hello from cf-mcp-test worker v1/);

      // ---- secrets: set in one deployed version, readable by the Worker, never echoed ----
      const setSecrets = await call("set_secrets", {
        script_name: workerName,
        secrets: { LIVE_SECRET: "v1-live" },
      });
      assert.equal(setSecrets.isError, false, `set_secrets failed: ${JSON.stringify(setSecrets.payload)}`);
      assert.ok(!JSON.stringify(setSecrets.payload).includes("v1-live"), "secret values are never echoed");
      const listed = await call("list_secrets", { script_name: workerName });
      assert.deepEqual(
        (listed.payload.data?.secrets as Array<{ name: string }>).map((s) => s.name),
        ["LIVE_SECRET"]
      );
      await fetchUntilBody(workerUrl, /secret=v1-live/, 120000);

      // ---- a code redeploy keeps existing secrets (Workers API versions drop unlisted bindings) ----
      const redeployWorker = await call("deploy_worker", {
        script_name: workerName,
        modules: workerCode(),
        bindings: [{ type: "plain_text", name: "LABEL", text: "v2" }],
      });
      assert.equal(redeployWorker.isError, false, `redeploy failed: ${JSON.stringify(redeployWorker.payload)}`);
      assert.deepEqual(redeployWorker.payload.data?.secrets_kept, ["LIVE_SECRET"]);
      await fetchUntilBody(workerUrl, /worker v2 secret=v1-live/, 120000);

      // ---- update_worker_settings: bindings + Worker-level observability, secrets kept ----
      const updated = await call("update_worker_settings", {
        script_name: workerName,
        bindings: [{ type: "plain_text", name: "LABEL", text: "settings" }],
        observability: { enabled: true },
      });
      assert.equal(updated.isError, false, `update_worker_settings failed: ${JSON.stringify(updated.payload)}`);
      assert.deepEqual(updated.payload.data?.secrets_kept, ["LIVE_SECRET"]);
      const settingsVersion = updated.payload.data?.version_id as string;
      assert.ok(settingsVersion, "binding changes deploy a new version");
      await fetchUntilBody(workerUrl, /worker settings secret=v1-live/, 120000);

      // ---- get_worker / get_worker_code read the live version ----
      const info = await call("get_worker", { script_name: workerName });
      assert.equal(info.isError, false, `get_worker failed: ${JSON.stringify(info.payload)}`);
      const settings = info.payload.data?.settings as {
        live_version_id?: string;
        main_module?: string;
        bindings?: Array<{ name: string; type: string }>;
        observability?: { enabled?: boolean };
      };
      assert.equal(settings.live_version_id, settingsVersion);
      assert.equal(settings.main_module, "index.js");
      assert.deepEqual(
        (settings.bindings ?? []).map((b) => `${b.type}:${b.name}`).sort(),
        ["plain_text:LABEL", "secret_text:LIVE_SECRET"]
      );
      assert.equal(settings.observability?.enabled, true);
      assert.equal((info.payload.data?.workers_dev as { url?: string }).url, workerUrl);
      const code = await call("get_worker_code", { script_name: workerName });
      assert.equal(code.isError, false, `get_worker_code failed: ${JSON.stringify(code.payload)}`);
      const codeModules = code.payload.data?.modules as Array<{ name: string; content: string }>;
      assert.equal(codeModules[0].name, "index.js");
      assert.equal(codeModules[0].content, workerCode()[0].content, "downloaded code round-trips exactly");

      // ---- tail_worker: trigger_url's request and its console.log are captured ----
      const tail = await call("tail_worker", {
        script_name: workerName,
        duration_seconds: 20,
        max_events: 1,
        search: "tail-check",
        trigger_url: new URL("/tail-check", workerUrl).toString(),
      });
      assert.equal(tail.isError, false, `tail_worker failed: ${JSON.stringify(tail.payload)}`);
      const tailed = tail.payload.data?.events as Array<{ request?: string; logs?: string[] }>;
      assert.equal(tailed.length, 1, `expected the triggered request: ${JSON.stringify(tail.payload.data)}`);
      assert.match(tailed[0].request ?? "", /GET \/tail-check/);
      assert.match((tailed[0].logs ?? []).join("\n"), /cf-mcp-test log \/tail-check/);

      // ---- staged version: production untouched, inherit-based edits refuse ----
      const staged = await call("create_version", {
        script_name: workerName,
        modules: workerCode("staged-"),
        bindings: [{ type: "plain_text", name: "LABEL", text: "x" }],
        message: "cf-mcp-test staged",
      });
      assert.equal(staged.isError, false, `create_version failed: ${JSON.stringify(staged.payload)}`);
      const stagedId = (staged.payload.data?.version as { id: string }).id;
      const refused = await call("update_worker_settings", {
        script_name: workerName,
        compatibility_date: "2026-11-01",
      });
      assert.equal(refused.isError, true, "a staged latest version must block inherit-based updates");
      assert.match(JSON.stringify(refused.payload), /staged, not live/);
      assert.match(await (await fetch(workerUrl)).text(), /worker settings secret=v1-live/, "staging doesn't touch production");

      const promote = await call("create_deployment", {
        script_name: workerName,
        versions: [{ version_id: stagedId, percentage: 100 }],
      });
      assert.equal(promote.isError, false, `create_deployment failed: ${JSON.stringify(promote.payload)}`);
      await fetchUntilBody(workerUrl, /worker staged-x secret=v1-live/, 120000);
      const rollback = await call("rollback_worker", { script_name: workerName, version_id: settingsVersion });
      assert.equal(rollback.isError, false, `rollback_worker failed: ${JSON.stringify(rollback.payload)}`);
      await fetchUntilBody(workerUrl, /worker settings secret=v1-live/, 120000);
      const versionList = await call("list_versions", { script_name: workerName });
      assert.ok(
        (versionList.payload.data?.versions as Array<{ message?: string }>).some((v) => v.message === "cf-mcp-test staged"),
        "list_versions should return the staged version's message"
      );

      // After the rollback the newest (staged) version isn't live, and
      // Cloudflare itself blocks secret edits until it is (error 10215).
      const blocked = await call("delete_secret", { script_name: workerName, name: "LIVE_SECRET" });
      assert.equal(blocked.isError, true, "secret edits are blocked while latest isn't deployed");
      assert.equal(blocked.payload.code, "CF_10215");
      assert.match(String(blocked.payload.suggestion), /create_deployment/);
      // A full code deploy makes latest live again (and still keeps the secret).
      const relive = await call("deploy_worker", {
        script_name: workerName,
        modules: workerCode(),
        bindings: [{ type: "plain_text", name: "LABEL", text: "final" }],
      });
      assert.deepEqual(relive.payload.data?.secrets_kept, ["LIVE_SECRET"]);
      await fetchUntilBody(workerUrl, /worker final secret=v1-live/, 120000);

      const delSecret = await call("delete_secret", { script_name: workerName, name: "LIVE_SECRET" });
      assert.equal(delSecret.isError, false, `delete_secret failed: ${JSON.stringify(delSecret.payload)}`);
      const afterDelete = await call("list_secrets", { script_name: workerName });
      assert.deepEqual(afterDelete.payload.data?.secrets, []);

      // ---- previews (beta): code preview serves while production is untouched ----
      const codePreview = await call("deploy_preview", {
        script_name: workerName,
        preview_name: "live-check",
        modules: [
          { name: "index.js", content: "export default { fetch() { return new Response('cf-mcp-test preview build'); } }" },
        ],
      });
      assert.equal(codePreview.isError, false, `deploy_preview failed: ${JSON.stringify(codePreview.payload)}`);
      const codePreviewUrl = (codePreview.payload.data?.preview as { url?: string }).url;
      assert.ok(codePreviewUrl, `expected a stable preview URL: ${JSON.stringify(codePreview.payload.data)}`);
      await fetchUntilBody(codePreviewUrl, /cf-mcp-test preview build/, 120000);
      assert.match(await (await fetch(workerUrl)).text(), /hello from cf-mcp-test worker/, "production unchanged");

      // Static-site preview: assets plus the _headers rule must apply.
      const sitePreview = await call("deploy_preview", {
        script_name: scriptName,
        preview_name: "site-check",
        directory: siteDir,
        not_found_handling: "404-page",
      });
      assert.equal(sitePreview.isError, false, `site deploy_preview failed: ${JSON.stringify(sitePreview.payload)}`);
      const sitePreviewUrl = (sitePreview.payload.data?.preview as { url?: string }).url;
      assert.ok(sitePreviewUrl, "expected a stable site preview URL");
      await fetchUntilBody(sitePreviewUrl, new RegExp(scriptName), 120000);
      assert.equal(
        (await fetch(sitePreviewUrl)).headers.get("x-cf-mcp-test"),
        "1",
        "the _headers rule should apply on the preview"
      );

      const previews = await call("list_previews", { script_name: workerName });
      assert.ok(
        (previews.payload.data?.previews as Array<{ name: string }>).some((p) => p.name === "live-check"),
        "list_previews should include the preview"
      );
      const delPreview = await call("delete_preview", { script_name: workerName, preview: "live-check" });
      assert.equal(delPreview.isError, false, `delete_preview failed: ${JSON.stringify(delPreview.payload)}`);

      // ---- deploy_worker keep_assets on the site: code added, assets + config kept.
      // Runs after the site preview on purpose: preview deployments must not
      // count as "latest" for the staged-version guard.
      const withCode = await call("deploy_worker", {
        script_name: scriptName,
        keep_assets: true,
        modules: [{ name: "index.js", content: "export default { fetch() { return new Response('cf-mcp-test site code'); } }" }],
        bindings: [{ type: "assets", name: "ASSETS" }],
      });
      assert.equal(withCode.isError, false, `deploy_worker keep_assets failed: ${JSON.stringify(withCode.payload)}`);
      const siteInfo = await call("get_worker", { script_name: scriptName });
      const siteSettings = siteInfo.payload.data?.settings as {
        live_version_id?: string;
        main_module?: string;
        assets_config?: { not_found_handling?: string };
      };
      assert.equal(siteSettings.live_version_id, withCode.payload.data?.version_id);
      assert.equal(siteSettings.main_module, "index.js");
      assert.equal(siteSettings.assets_config?.not_found_handling, "404-page", "asset config inherited");
      await new Promise((resolve) => setTimeout(resolve, 15000));
      assert.match(await fetchUntilOk(url, 60000), new RegExp(scriptName), "assets still served after adding code");

      // ---- deploy_static_site over code: an assets-only version can't hold
      // bindings, so Cloudflare drops the secrets. The tool must say so. ----
      const siteSecret = await call("set_secrets", {
        script_name: scriptName,
        secrets: { SITE_SECRET: "cf-mcp-test-site" },
      });
      assert.equal(siteSecret.isError, false, `set_secrets on site failed: ${JSON.stringify(siteSecret.payload)}`);
      const backToSite = await call("deploy_static_site", {
        script_name: scriptName,
        directory: siteDir,
        not_found_handling: "404-page",
      });
      assert.equal(backToSite.isError, false, `deploy_static_site over code failed: ${JSON.stringify(backToSite.payload)}`);
      assert.deepEqual(backToSite.payload.data?.secrets_dropped, ["SITE_SECRET"]);
      assert.match(String(backToSite.payload.data?.warning), /set_secrets/);
      const siteSecrets = await call("list_secrets", { script_name: scriptName });
      assert.deepEqual(
        siteSecrets.payload.data?.secrets,
        [],
        `the warning matches reality: ${JSON.stringify(siteSecrets.payload)}`
      );

      // ---- set_workers_dev toggles serving and reports the URL ----
      const off = await call("set_workers_dev", { script_name: workerName, enabled: false });
      assert.equal(off.isError, false, `set_workers_dev off failed: ${JSON.stringify(off.payload)}`);
      assert.equal(off.payload.data?.enabled, false);
      assert.equal(off.payload.data?.url, undefined);
      const on = await call("set_workers_dev", { script_name: workerName, enabled: true });
      assert.equal(on.payload.data?.enabled, true);
      assert.equal(on.payload.data?.url, workerUrl);

      // ---- get_worker_code on a service-worker-syntax Worker (legacy fallback) ----
      // Created with a raw legacy upload: the tools only produce module Workers.
      const swName = `${scriptName}-sw`;
      needsCleanup.add(swName);
      const swForm = new FormData();
      swForm.append(
        "metadata",
        new File([JSON.stringify({ body_part: "script", compatibility_date: "2026-11-05" })], "metadata.json", {
          type: "application/json",
        })
      );
      const swSource = 'addEventListener("fetch", (e) => e.respondWith(new Response("cf-mcp-test sw")));';
      swForm.append("script", new File([swSource], "script", { type: "application/javascript" }));
      const swUpload = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${swName}`,
        { method: "PUT", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body: swForm }
      );
      assert.equal(swUpload.ok, true, "raw service-worker upload should succeed");
      const swCode = await call("get_worker_code", { script_name: swName });
      assert.equal(swCode.isError, false, `get_worker_code (sw) failed: ${JSON.stringify(swCode.payload)}`);
      assert.match(
        (swCode.payload.data?.modules as Array<{ content: string }>).map((m) => m.content).join("\n"),
        /cf-mcp-test sw/
      );

      // ---- deploy_worker from local files (issue #1), including a binary .wasm module ----
      const fileName = `${scriptName}-f`;
      needsCleanup.add(fileName);
      const fromDisk = await call("deploy_worker", {
        script_name: fileName,
        modules: [{ path: join(modDir, "worker.js") }, { path: join(modDir, "add.wasm") }],
      });
      assert.equal(fromDisk.isError, false, `deploy_worker from paths failed: ${JSON.stringify(fromDisk.payload)}`);
      assert.equal(fromDisk.payload.data?.main_module, "worker.js");
      assert.deepEqual(fromDisk.payload.data?.modules, ["worker.js", "add.wasm"]);
      assert.match(await fetchUntilOk(String(fromDisk.payload.data?.url), 180000), /cf-mcp-test from disk 2\+3=5/);

      // Delete everything through the tool and unmark cleanup.
      for (const name of [workerName, scriptName, swName, fileName]) {
        const del = await call("delete_worker", { script_name: name, force: true });
        assert.equal(del.isError, false, `delete_worker failed: ${JSON.stringify(del.payload)}`);
        needsCleanup.delete(name);
      }
    } finally {
      for (const name of needsCleanup) {
        try {
          await direct.deleteWorker(name, true);
        } catch {
          // Best-effort cleanup; don't mask the real assertion failure.
        }
      }
      await client.close();
      await rm(siteDir, { recursive: true, force: true });
      await rm(modDir, { recursive: true, force: true });
    }
  }
);
