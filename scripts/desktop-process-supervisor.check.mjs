import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { superviseProcess } from "./desktop-process-supervisor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    // Linux can retain an exited orphan as a zombie until init reaps it.
    if (process.platform !== "win32") {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
    }
    return true;
  } catch { return false; }
};

async function fixture(t, mode, watchChange) {
  const directory = mkdtempSync(join(tmpdir(), "desktop-supervisor-check-"));
  const watched = join(directory, "volume");
  mkdirSync(watched);
  const pidsFile = join(directory, "pids.json");
  let pids;
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(async () => {
    sentinel.kill("SIGKILL");
    if (pids) {
      if (process.platform !== "win32") { try { process.kill(-pids.root, "SIGKILL"); } catch {} }
      for (const pid of [pids.worker, pids.root]) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const source = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const worker = spawn(process.execPath, ["-e", '/* desktop-supervisor-check worker */ process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");'], { stdio: ["ignore", "pipe", "ignore"] });
    worker.stdout.once("data", () => {
      writeFileSync(process.argv[1], JSON.stringify({ root: process.pid, worker: worker.pid }));
      if (process.argv[2] === "exit") process.exit(0);
      else if (process.argv[2] === "crash") process.kill(process.pid, "SIGKILL");
    });
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
  const abort = new AbortController();
  const completion = superviseProcess({
    command: process.execPath,
    args: ["-e", source, pidsFile, mode],
    cwd: directory,
    watchPaths: [watched],
    signal: abort.signal,
    pollMs: 30,
    graceMs: 100,
    healthTimeoutMs: 500,
    stdio: "ignore",
    report: () => {},
  });
  // Attach a rejection handler before asynchronous fixture setup.
  completion.catch(() => {});
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(readFileSync(pidsFile, "utf8")); break; } catch {}
    await delay(20);
  }
  assert.ok(pids, "fixture started");
  if (mode === "hang") {
    if (watchChange === "missing") rmSync(watched, { recursive: true });
    else if (watchChange === "replace") { renameSync(watched, `${watched}-old`); mkdirSync(watched); }
    else abort.abort();
  }
  const result = await completion;
  for (let retry = 0; retry < 40 && (alive(pids.root) || alive(pids.worker)); retry += 1) await delay(25);
  assert.equal(alive(pids.root), false, "main process exited");
  assert.equal(alive(pids.worker), false, "orphan worker exited");
  assert.equal(alive(sentinel.pid), true, "unrelated process remains alive");
  return result;
}

test("cleans orphan children after a normal main exit", { timeout: 20000, skip: process.platform === "win32" }, async (t) => {
  assert.equal((await fixture(t, "exit")).code, 0);
});
test("cleans orphan children after the main process crashes", { timeout: 20000, skip: process.platform === "win32" }, async (t) => {
  assert.equal((await fixture(t, "crash")).code, 137);
});
test("escalates shutdown when processes ignore termination", { timeout: 20000, skip: process.platform === "win32" }, async (t) => {
  assert.equal((await fixture(t, "hang")).reason, "interrupted");
});
test("stops the entire owned group when the backing directory disappears", { timeout: 20000, skip: process.platform === "win32" }, async (t) => {
  const result = await fixture(t, "hang", "missing");
  assert.equal(result.reason, "storage-unavailable");
  assert.equal(result.code, 1);
});
test("detects a backing directory replaced at the same path", { timeout: 20000, skip: process.platform === "win32" }, async (t) => {
  assert.equal((await fixture(t, "hang", "replace")).reason, "storage-unavailable");
});

test("reports a failed launch without hanging cleanup", { timeout: 3000, skip: process.platform === "win32" }, async () => {
  const result = await superviseProcess({ command: "/missing-desktop-supervisor-executable", stdio: "ignore", report: () => {} });
  assert.deepEqual(result, { reason: "launch-failed", code: 1 });
});

test("an already interrupted launch starts no process", { timeout: 3000, skip: process.platform === "win32" }, async () => {
  const abort = new AbortController();
  abort.abort("SIGTERM");
  const result = await superviseProcess({ command: "/missing-desktop-supervisor-executable", signal: abort.signal });
  assert.deepEqual(result, { reason: "interrupted", code: 143 });
});
