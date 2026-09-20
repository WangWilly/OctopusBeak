import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function redact(value: string, directory: string) {
  return value.replaceAll(directory, "<TEMP>").trim().slice(-1200);
}

test("Electron safeStorage decrypt/snapshot P95 is <=50ms in isolated userData", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "automation-safe-storage-"));
  const userData = join(directory, "user-data");
  const probe = fileURLToPath(new URL("./automation-credential-safe-storage-probe.mjs", import.meta.url));
  const electronPath = createRequire(import.meta.url)("electron") as string;
  try {
    const result = await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      output: string;
      error: string;
    }>((resolveResult) => {
      const child = spawn(
        electronPath,
        ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, probe],
        {
          cwd: directory,
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-strip-types"].filter(Boolean).join(" "),
            OCTOPUSBEAK_USER_DATA: userData,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let error = "";
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        value: { status: number | null; signal: NodeJS.Signals | null },
        timedOut = false,
      ) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolveResult({ ...value, timedOut, output, error });
      };
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.once("exit", (status, signal) => finish({ status, signal }));
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ status: null, signal: "SIGTERM" }, true);
      }, 15_000);
      child.once("error", () => finish({ status: null, signal: null }));
    });

    if (result.timedOut) {
      assert.fail(`Electron safeStorage probe timed out; stdout=${redact(result.output, directory)} stderr=${redact(result.error, directory)}`);
    }
    const knownMacElectronInitializationAbort =
      process.platform === "darwin" &&
      result.signal === "SIGABRT" &&
      result.status === null &&
      result.output.trim() === "" &&
      result.error.trim() === "";
    if (knownMacElectronInitializationAbort) {
      t.skip("Electron safeStorage runtime hit the known macOS NSApplication SIGABRT initialization failure.");
      return;
    }
    if (result.signal) {
      assert.fail(`Electron safeStorage probe exited with unexpected signal ${result.signal}; stdout=${redact(result.output, directory)} stderr=${redact(result.error, directory)}`);
    }
    const report = result.output.trim().split("\n").map((line) => {
      try {
        return JSON.parse(line) as { status?: string; reason?: string; snapshotP95Ms?: number; backend?: string };
      } catch {
        return null;
      }
    }).find((value) => value !== null);
    if (report?.status === "skipped" || result.status === 77) {
      t.skip(`Electron safeStorage unavailable in isolated runtime (${report?.reason ?? "status-77"}, backend=${report?.backend ?? "unknown"}); stderr=${redact(result.error, directory)}`);
      return;
    }
    assert.equal(result.status, 0, `safeStorage probe failed: stdout=${redact(result.output, directory)} stderr=${redact(result.error, directory)}`);
    assert.equal(report?.status, "passed", `safeStorage probe did not produce passing evidence: ${redact(result.output, directory)}`);
    assert.ok((report?.snapshotP95Ms ?? Infinity) <= 50);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
