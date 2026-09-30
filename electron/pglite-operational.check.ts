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
import { createPGliteOperationalRuntime } from "./pglite-runtime.ts";
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
  const runtime = createPGliteOperationalRuntime({ dataDir, worker: client });
  try {
    assert.equal(runtime.provider.pgliteWorkflow.required, true);
    const created = await runtime.provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:00.000Z",
    });
    assert.ok(created.taskRunId);
    assert.equal(
      (await runtime.provider.automation.taskRunById(created.taskRunId))?.status,
      "running",
    );
    const typedRun = await runtime.provider.automation.createTaskRun({
      taskId: "esun-credit-card-statements",
      kind: "crawler",
      status: "preparing",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:01:00.000Z",
    });
    assert.ok(typedRun.taskRunId);
    assert.equal(
      (await runtime.provider.automation.taskRunById(typedRun.taskRunId))?.taskId,
      "esun-credit-card-statements",
    );
    await runtime.provider.automation.updateTaskRun(created.taskRunId, {
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "completed", counts: { rowCount: 7 } },
      },
    });
    assert.equal(
      (await runtime.provider.automation.taskRunById(created.taskRunId))?.appWorkflowOutcome?.summary?.counts.rowCount,
      7,
    );
    await runtime.provider.automation.appendRunEvent({
      runId: created.taskRunId,
      stage: "collection",
      code: "source-complete",
      occurredAt: "2026-09-22T00:00:00.000Z",
      completed: 1,
      total: 1,
    });
    assert.equal(
      (await runtime.provider.automation.taskRunById(created.taskRunId))?.events[0]?.code,
      "source-complete",
    );
    await runtime.provider.exchangeRates.upsertExchangeRates([{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.5,
      source: "check",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);
    assert.deepEqual(await runtime.provider.exchangeRates.readExchangeRates(["USD"]), [{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 31.5,
      source: "check",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }]);

    await assert.rejects(
      runtime.provider.automation.updateTaskRun("missing-run", {
        appWorkflowOutcome: { errorCode: null, summary: null },
      }),
      /PGlite operational operation failed/u,
    );
    await assert.rejects(
      rawClient.request("SELECT 1" as PGliteOperationalOperation, []),
      /Invalid PGlite operational request/u,
      "the wire rejects arbitrary SQL names",
    );
    const typedRunRequest = {
      taskId: "esun-credit-card-statements",
      kind: "crawler",
      status: "preparing",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:02:00.000Z",
    };
    await assert.rejects(
      rawClient.request("automation.createTaskRun" as PGliteOperationalOperation, [{
        ...typedRunRequest,
        script: "workflow:legacy",
        errorMessage: "unsafe raw error",
        logTail: "secret=must-not-cross-rpc",
        logPath: "../outside.log",
      }]),
      /Invalid PGlite operational request/u,
      "the wire rejects all retired script and diagnostic fields",
    );
    await assert.rejects(
      rawClient.request("automation.updateTaskRun" as PGliteOperationalOperation, [
        created.taskRunId,
        { logTail: "secret=must-not-cross-rpc", errorMessage: "unsafe raw error" },
      ]),
      /Invalid PGlite operational request/u,
      "the wire rejects retired fields on updates as well as creates",
    );
    await assert.rejects(
      rawClient.request("automation.createTaskRun" as PGliteOperationalOperation, [{
        ...typedRunRequest,
        taskId: "",
      }]),
      /Invalid PGlite operational request/u,
      "the wire still requires task identity fields",
    );
    assert.equal(
      (await runtime.provider.automation.taskRunById(created.taskRunId))?.appWorkflowOutcome?.summary?.counts.rowCount,
      7,
      "the provider remains usable after an operation failure",
    );
  } finally {
    await runtime.close();
    rawClient.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the operational runtime requires its PGlite data directory", () => {
  assert.throws(
    () => createPGliteOperationalRuntime({ dataDir: "" }),
    /requires an explicit data directory/u,
  );
});

test("Electron main starts the required PGlite provider without SQLite startup", async () => {
  const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /createPGliteOperationalRuntime\(/u);
  assert.match(source, /recoverInterruptedAutomationRuns\(operationalRuntime\.provider\)/u);
  assert.doesNotMatch(source, /initializeCanonicalRuntimeBeforeWindow|ledgerDir|pgliteOperationalEnabled/u);
});

test("closing the operational transport rejects requests still waiting on the wire", async () => {
  const port = new SilentPort();
  const client = createPGliteOperationalRpcClient(port);
  const pending = client.provider.automation.activeTaskRuns();
  client.close();
  await assert.rejects(pending, /PGlite operational worker is closed/u);
});
