import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { superviseWorker } from "./pglite-worker-supervisor.ts";

function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (value !== undefined) resolve(value);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

test("a killed PGlite worker is replaced on the same database and its live view resumes", { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-recovery-"));
  const rawWorkers: Worker[] = [];
  const restarts: string[] = [];
  const failures: Error[] = [];
  const supervised = superviseWorker({
    spawn: () => {
      const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
        execArgv: ["--experimental-strip-types"],
        workerData: { dataDir, settingsPath: join(dataDir, "settings.json") },
      });
      rawWorkers.push(worker);
      return createPGliteViewWorkerClient(worker);
    },
    onRestart: (error) => restarts.push(error.message),
  });
  supervised.onError((error) => failures.push(error));
  try {
    await supervised.ready;
    const created = await supervised.operationalProvider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-11-08T00:00:00.000Z",
    });
    const values: unknown[] = [];
    const stop = await supervised.subscribe("financial.overview.current", {}, (value) => values.push(value));
    await waitFor(() => (values.length > 0 ? true : undefined), "the first overview value");
    const before = values.length;

    await rawWorkers[0]!.terminate();
    await waitFor(() => (rawWorkers.length === 2 ? true : undefined), "a second worker");
    assert.deepEqual(restarts, ["PGlite view worker exited with code 1."]);

    await waitFor(() => (values.length > before ? true : undefined), "the overview to publish from the new worker");
    assert.equal(
      (await supervised.operationalProvider.automation.taskRunById(created.taskRunId))?.status,
      "running",
      "the new worker opened the same database, with the row written before the crash",
    );
    assert.equal((await supervised.financial.request("financial.overview.current", [])).availability, "empty");
    assert.deepEqual(failures, [], "the IPC bridge never saw the worker as unavailable");
    await stop();
  } finally {
    await supervised.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a worker that throws is closed and exited before its replacement opens the database", { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-recovery-throw-"));
  const entry = new URL("./pglite-view-worker.ts", import.meta.url).href;
  const timeline: string[] = [];
  const rawWorkers: Worker[] = [];
  const supervised = superviseWorker({
    spawn: () => {
      const index = rawWorkers.length;
      timeline.push(`spawn ${index}`);
      // The real worker entry, plus a listener that throws outside any handler on request.
      const worker = new Worker(
        `const { parentPort } = require("node:worker_threads");
         parentPort.on("message", (message) => {
           if (message && message.kind === "check-crash") setImmediate(() => { throw new Error("check crash"); });
         });
         import(${JSON.stringify(entry)});`,
        {
          eval: true,
          execArgv: ["--experimental-strip-types"],
          workerData: { dataDir, settingsPath: join(dataDir, "settings.json") },
        },
      );
      worker.on("error", () => timeline.push(`error ${index}`));
      worker.on("exit", () => timeline.push(`exit ${index}`));
      rawWorkers.push(worker);
      return createPGliteViewWorkerClient(worker);
    },
  });
  try {
    await supervised.ready;
    const values: unknown[] = [];
    const stop = await supervised.subscribe("financial.overview.current", {}, (value) => values.push(value));
    await waitFor(() => (values.length > 0 ? true : undefined), "the first overview value");
    const before = values.length;
    rawWorkers[0]!.postMessage({ kind: "check-crash" });
    await waitFor(() => (values.length > before ? true : undefined), "the overview to publish from the new worker");
    assert.deepEqual(
      timeline.slice(0, 4),
      ["spawn 0", "error 0", "exit 0", "spawn 1"],
      "the thrown worker's error arrives before its exit, and the new worker starts only after the exit",
    );
    assert.equal((await supervised.financial.request("financial.overview.current", [])).availability, "empty");
    await stop();
  } finally {
    await supervised.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
