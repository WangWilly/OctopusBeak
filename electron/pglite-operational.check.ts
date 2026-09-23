import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteOperationalRpcClient,
  type PGliteOperationalOperation,
} from "./pglite-operational-rpc.ts";
import { createPGliteOperationalRuntime, pgliteOperationalEnabled } from "./pglite-runtime.ts";
import { createPGliteViewWorkerClient } from "./pglite-view-worker-client.ts";

class SilentPort {
  readonly listeners = new Set<(value: unknown) => void>();

  on(_event: "message", listener: (value: unknown) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "message", listener: (value: unknown) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(_value: unknown): void {}
}

test("the worker exposes operational start/read/write/failure through one provider", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-operational-rpc-check-"));
  const worker = new Worker(new URL("./pglite-view-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { dataDir },
  });
  const client = createPGliteViewWorkerClient(worker);
  const rawClient = createPGliteOperationalRpcClient(worker);
  try {
    const created = await client.operationalProvider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:00.000Z",
      logPath: "data/automation/logs/operational-rpc.log",
      logTail: "safe-progress",
    });
    assert.ok(created.taskRunId);
    assert.equal(
      (await client.operationalProvider.automation.taskRunById(created.taskRunId))?.status,
      "running",
    );
    await client.operationalProvider.automation.updateTaskRun(created.taskRunId, {
      logTail: "updated-progress",
    });
    assert.equal(
      (await client.operationalProvider.automation.taskRunById(created.taskRunId))?.logTail,
      "updated-progress",
    );
    await client.operationalProvider.exchangeRates.upsertExchangeRates([{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.5,
      source: "check",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);
    assert.deepEqual(await client.operationalProvider.exchangeRates.readExchangeRates(["USD"]), [{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.5,
      source: "check",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);

    await assert.rejects(
      client.operationalProvider.automation.updateTaskRun("missing-run", { logTail: "x" }),
      /PGlite operational operation failed/u,
    );
    await assert.rejects(
      rawClient.request("SELECT 1" as PGliteOperationalOperation, []),
      /Invalid PGlite operational request/u,
      "the wire rejects arbitrary SQL names",
    );
    assert.equal(
      (await client.operationalProvider.automation.taskRunById(created.taskRunId))?.logTail,
      "updated-progress",
      "the provider remains usable after an operation failure",
    );
  } finally {
    await client.close();
    rawClient.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the central operational gate remains off unless explicitly enabled", () => {
  assert.equal(pgliteOperationalEnabled({}), false);
  assert.equal(
    createPGliteOperationalRuntime({
      enabled: false,
      dataDir: "/tmp/this-must-not-open",
    }),
    null,
  );
  assert.equal(
    createPGliteOperationalRuntime({
      enabled: false,
      dataDir: "/tmp/this-must-not-open",
    }),
    null,
    "an explicit false activation wins over an ambient environment switch",
  );
});

test("Electron main keeps the operational provider behind the central gate", async () => {
  const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /enabled:\s*pgliteOperationalEnabled\(\)/u);
  assert.match(source, /createPGliteOperationalRuntime\(/u);
  assert.match(source, /pgliteOperationalRuntime\?\.provider/u);
});

test("closing the operational transport rejects requests still waiting on the wire", async () => {
  const port = new SilentPort();
  const client = createPGliteOperationalRpcClient(port);
  const pending = client.provider.automation.activeTaskRuns();
  client.close();
  await assert.rejects(pending, /PGlite operational worker is closed/u);
});
