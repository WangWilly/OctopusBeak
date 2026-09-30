import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { createPGliteOperationalRpcClient, createPGliteOperationalRpcServer } from "../../../electron/pglite-operational-rpc.ts";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "./operational.ts";
import { PGliteStore } from "./transaction.ts";
import { PGlite } from "@electric-sql/pglite";

test("operational RPC persists typed outcomes and exact schedule occurrence markers", async () => {
  const store = new PGliteStore(await PGlite.create());
  const channel = new MessageChannel();
  const server = createPGliteOperationalRpcServer(
    channel.port1,
    createPgliteOperationalProvider(store),
  );
  const client = createPGliteOperationalRpcClient(channel.port2);
  const occurrence = "2026-09-25T03:00:00.000Z";
  try {
    await applyPgliteOperationalBaseline(store);
    const created = await client.provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-25T03:00:01.000Z",
      scheduledAtUtc: occurrence,
    });
    await client.provider.automation.transitionTaskRunToTerminal(created.taskRunId, {
      status: "completed",
      finishedAt: "2026-09-25T03:00:02.000Z",
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "completed", counts: { rowCount: 8 } },
      },
    });

    assert.equal(await client.provider.automation.hasOccurrenceBeenAttempted("exchange-rates", occurrence), true);
    assert.equal(await client.provider.automation.hasOccurrenceBeenAttempted("exchange-rates", "2026-09-25T03:00:03.000Z"), false);
    const stored = await client.provider.automation.taskRunById(created.taskRunId);
    assert.equal(stored?.scheduledAtUtc, occurrence);
    assert.deepEqual(stored?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "completed", counts: { rowCount: 8 } },
    });
    assert.equal(Object.hasOwn(stored ?? {}, "script"), false);
    assert.equal(Object.hasOwn(stored ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(stored ?? {}, "logTail"), false);
    assert.equal(Object.hasOwn(stored ?? {}, "errorMessage"), false);
    const history = await client.provider.automation.recentTaskRuns();
    assert.deepEqual(history[0]?.appWorkflowOutcome, stored?.appWorkflowOutcome);
    assert.equal(Object.hasOwn(history[0] ?? {}, "errorMessage"), false);
    await assert.rejects(
      client.provider.automation.createTaskRun({
        taskId: "exchange-rates",
        kind: "sync",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: "2026-09-25T03:00:03.000Z",
        script: "run:exchange-rates",
      } as never),
      /Invalid PGlite operational request/u,
    );
  } finally {
    client.close();
    await server.close();
    channel.port1.close();
    channel.port2.close();
    await store.close();
  }
});
