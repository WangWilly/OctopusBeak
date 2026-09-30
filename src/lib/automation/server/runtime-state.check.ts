import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutomationRuntimeSnapshot,
  createAutomationRuntimeState,
  runtimeTaskSnapshotFromRun,
} from "./runtime-state.ts";

test("runtime state broadcasts monotonic snapshots with typed outcomes and no log payload", () => {
  const state = createAutomationRuntimeState("session-test");
  const events: number[] = [];
  state.subscribe((snapshot) => events.push(snapshot.revision));
  const snapshot = state.upsert({
    taskId: "esun-credit-card-statements",
    runId: "run-1",
    status: "running" as const,
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: "download", completed: 1, total: 2, percent: 50, attempt: 1 },
    appWorkflowOutcome: {
      errorCode: "source-validation-failed",
      summary: { status: "failed", counts: { rowCount: 12 } },
    },
    updatedAt: new Date().toISOString(),
  });
  assert.equal(snapshot.sessionId, "session-test");
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(events, [1]);
  assert.deepEqual(snapshot.tasks[0]!.appWorkflowOutcome, {
    errorCode: "source-validation-failed",
    summary: { status: "failed", counts: { rowCount: 12 } },
  });
  assert.equal("logTail" in snapshot.tasks[0]!, false);
  assert.equal("errorMessage" in snapshot.tasks[0]!, false);
  assert.equal("statementFailures" in snapshot.tasks[0]!, false);
  assert.equal(state.snapshot().tasks[0]?.runId, "run-1");
});

test("runtime snapshot rejects malformed persisted progress and duplicate tasks", () => {
  const task = {
    taskId: "exchange-rates",
    runId: "run-1",
    status: "running" as const,
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: "sync", completed: 1, total: 2, percent: 50, attempt: 1 },
    appWorkflowOutcome: null,
    updatedAt: new Date().toISOString(),
  };
  assert.doesNotThrow(() => assertAutomationRuntimeSnapshot({
    sessionId: "session-test",
    revision: 1,
    tasks: [task],
  }));
  assert.throws(() => assertAutomationRuntimeSnapshot({
    sessionId: "session-test",
    revision: 1,
    tasks: [{
      ...task,
      progress: { phaseCode: "sync", completed: Number.NaN, total: 2, percent: 50, attempt: 1 },
    }],
  } as never), /Invalid automation runtime task snapshot/);
  assert.throws(() => assertAutomationRuntimeSnapshot({
    sessionId: "session-test",
    revision: 1,
    tasks: [task, { ...task, taskId: "exchange-rates" }],
  }), /Invalid automation runtime task snapshot/);
});

test("every run has a determinate terminal progress state", () => {
  const run = {
    taskId: "exchange-rates",
    taskRunId: "run-1",
    status: "partial" as const,
    attempt: 1,
    maxAttempts: 1,
    progress: {
      phaseCode: "sync",
      completed: 3,
      total: 4,
      percent: 75,
      attempt: 1,
    },
    appWorkflowOutcome: null,
  };
  const partial = runtimeTaskSnapshotFromRun(run);
  assert.equal(partial.status, "partial");
  assert.equal(partial.progress.percent, 75);
  assert.equal(partial.runId, "run-1");

  const completed = runtimeTaskSnapshotFromRun(run, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.percent, 100);
  assert.equal(completed.progress.completed, 100);
  assert.equal(completed.progress.total, 100);
});

test("production runtime state rejects unknown active tasks before publishing", () => {
  const state = createAutomationRuntimeState("session-test", {
    knownTaskIds: new Set(["known-task"]),
  });
  let broadcasts = 0;
  state.subscribe(() => { broadcasts += 1; });
  assert.throws(
    () => state.upsert({
      taskId: "unknown-task",
      runId: "run-unknown",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      progress: { phaseCode: null, completed: null, total: null, percent: null, attempt: 1 },
      appWorkflowOutcome: null,
      updatedAt: new Date().toISOString(),
    }),
    /automation-unknown-active-task/,
  );
  assert.equal(broadcasts, 0);
  assert.doesNotThrow(() => state.upsert({
    taskId: "unknown-task",
    runId: "run-old",
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: null, completed: 1, total: 1, percent: 100, attempt: 1 },
    appWorkflowOutcome: null,
    updatedAt: new Date().toISOString(),
  }));
  assert.equal(broadcasts, 1);
});
