import assert from "node:assert/strict";
import test, { after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { openActiveTaskRun } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { TaskRunStop } from "./task-run-finalization.ts";

const database = await PGlite.create();
const store = new PGliteStore(database);
await applyPgliteOperationalBaseline(store);
after(() => database.close());
const persistence = createPgliteOperationalProvider(store).automation;

async function open(options: { forceQuitAvailableAfterMs?: number } = {}) {
  const { taskRunId } = await persistence.createTaskRun({
    taskId: "exchange-rates",
    kind: "sync",
    status: "preparing",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  const runtime = createAutomationRuntimeState();
  const row = await persistence.taskRunById(taskRunId);
  const run = openActiveTaskRun({ run: row!, persistence, runtime, ...options });
  const published = () => runtime.snapshot().tasks.find((task) => task.runId === taskRunId);
  return { run, runtime, published, taskRunId };
}

test("cancellation state survives later progress writes in the published snapshot", async () => {
  const { run, published } = await open({ forceQuitAvailableAfterMs: 20 });
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  const requestedAt = published()?.cancellationRequestedAt;
  assert.ok(requestedAt);
  assert.equal(published()?.forceTerminateAvailable, false);

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(published()?.forceTerminateAvailable, true, "force-quit is offered once cleanup had its time");
  await run.update({ progress: { phaseCode: "sync", completed: 1, total: 3, percent: 33, attempt: 1 } });
  assert.equal(published()?.status, "cancelling");
  assert.equal(published()?.cancellationRequestedAt, requestedAt);
  assert.equal(published()?.forceTerminateAvailable, true, "a progress write keeps the force-quit control");
  assert.equal(published()?.progress.percent, 33);
  await run.finish({ errorCode: null, summary: null });
});

test("a cancelling run refuses every move except its end", async () => {
  const { run, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  for (const status of ["running", "waiting_for_human", "queued", "preparing"] as const) {
    assert.equal(await run.transition(status), false, `cancelling moved to ${status}`);
  }
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "cancelling");
  assert.equal((await run.finish({ errorCode: null, summary: null })).status, "cancelled");
});

test("finish persists once and ignores later writes", async () => {
  const { run, published, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  const [first, second] = await Promise.all([
    run.finish({ errorCode: null, summary: null }),
    run.finish({ errorCode: "workflow-failed", summary: null }),
  ]);
  assert.equal(first.status, "completed");
  assert.equal(second, first);
  assert.equal(await run.transition("running"), false);
  await run.update({ attempt: 2 });
  await run.requestStop("cancelled");
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.attempt, 1);
  assert.equal(published()?.status, "completed");
  assert.equal(run.signal.aborted, false);
});

for (const { stops, status, forced } of [
  { stops: ["cancelled", "shutdown"], status: "cancelled", forced: false },
  { stops: ["shutdown", "cancelled"], status: "cancelled", forced: false },
  { stops: ["cancelled", "forced"], status: "cancelled", forced: true },
  { stops: ["shutdown"], status: "interrupted", forced: false },
] satisfies Array<{ stops: TaskRunStop[]; status: string; forced: boolean }>) {
  test(`stops ${stops.join(" then ")} end the run ${forced ? "force-quit" : status}`, async () => {
    const { run } = await open();
    assert.equal(await run.transition("running"), true);
    for (const stop of stops) await run.requestStop(stop);
    assert.equal(run.signal.aborted, true);
    assert.equal(run.forceSignal.aborted, forced);
    const finished = await run.finish({ errorCode: null, summary: null });
    assert.equal(finished.status, status);
    assert.equal(finished.terminationMode === "forced", forced);
  });
}
