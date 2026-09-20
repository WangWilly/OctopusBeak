import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Run the real worker in a child process whose cwd contains an encrypted
 * envelope but whose codec is intentionally not configured.  The child
 * process is important: it gives the worker its own cwd without touching the
 * test runner's or the user's credential files.
 */
test("worker automation blocks never read an encrypted credential envelope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-worker-boundary-"));
  try {
    const builtWorkerPath = resolve("build-electron/financial-page-worker.cjs");
    assert.equal(
      existsSync(builtWorkerPath),
      true,
      "built worker is missing; run npm run build:electron (npm test does this in its pretest step)",
    );
    const sourceMtimes = [
      fileURLToPath(new URL("./financial-page-worker.ts", import.meta.url)),
      fileURLToPath(new URL("./financial-page-block-loader.ts", import.meta.url)),
      fileURLToPath(new URL("../src/lib/automation/server/desktop-api.ts", import.meta.url)),
    ].map((path) => statSync(path).mtimeMs);
    assert.ok(
      statSync(builtWorkerPath).mtimeMs >= Math.max(...sourceMtimes),
      "built worker is stale; run npm run build:electron before this regression",
    );
    const workerPath = builtWorkerPath;
    const ledgerDir = join(directory, "ledger");
    writeFileSync(join(directory, "settings.json"), "{}\n");
    writeFileSync(
      join(directory, "credentials.json"),
      JSON.stringify({
        format: "octopusbeak.credentials.safeStorage.v1",
        data: "synthetic-encrypted-envelope",
      }),
    );

  const childSource = `
    import { Worker } from "node:worker_threads";
    const worker = new Worker(${JSON.stringify(workerPath)}, {
      type: "commonjs",
      execArgv: ["--no-warnings"],
    });
    let nextId = 1;
    const waiters = new Map();
    worker.on("message", (message) => {
      if (message.id === 0) return;
      const resolve = waiters.get(message.id);
      if (!resolve) return;
      waiters.delete(message.id);
      resolve(message);
    });
    worker.on("error", (error) => {
      for (const resolve of waiters.values()) resolve({ ok: false, error: String(error) });
      waiters.clear();
    });
    const request = (value) => new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      worker.postMessage({ id, ...value });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker readiness timeout")), 5000);
      worker.once("message", (message) => {
        clearTimeout(timer);
        message.id === 0 && message.ok ? resolve() : reject(new Error("worker readiness failed"));
      });
      worker.once("error", reject);
    });
    const state = {
      revision: 1,
      status: {},
      fileNames: {},
      invalidFileKeys: [],
      invalidFileReasons: {},
      cathayGmailOtp: {
        enabled: false,
        connectedEmail: null,
        needsAuthorization: false,
      },
    };
    const results = {};
    for (const block of ["summary", "list", "details"]) {
      results[block] = await request({
        page: "block",
        target: "automation",
        block,
        ...(block === "details" ? { automationCredentialState: state } : {}),
      });
    }
    await worker.terminate();
    process.stdout.write(JSON.stringify(results));
  `;

    const result = await new Promise<{ status: number | null; output: string; error: string }>((resolveResult) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", childSource],
        { cwd: directory, env: { ...process.env, LEDGER_DIR: ledgerDir }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.once("exit", (status) => resolveResult({ status, output, error }));
    });
    assert.equal(result.status, 0, result.error || result.output);
    const results = JSON.parse(result.output) as Record<string, {
      ok: boolean;
      error?: string;
      value?: { data?: { automation?: Record<string, unknown> } };
    }>;
    for (const block of ["summary", "list", "details"]) {
      assert.equal(results[block]?.ok, true, `${block} worker block failed: ${results[block]?.error ?? "unknown"}`);
      assert.doesNotMatch(results[block]?.error ?? "", /Credential encryption is not configured/u);
    }
    assert.equal(Object.hasOwn(results.summary?.value?.data?.automation ?? {}, "cathayGmailOtp"), false);
    assert.equal(Object.hasOwn(results.list?.value?.data?.automation ?? {}, "cathayGmailOtp"), false);
    assert.deepEqual(results.details?.value?.data?.automation?.cathayGmailOtp, {
      enabled: false,
      connectedEmail: null,
      needsAuthorization: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
