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
