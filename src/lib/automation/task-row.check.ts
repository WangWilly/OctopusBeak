import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRuntimeTaskSnapshot } from "../desktop/api.ts";
import type { AutomationTaskRow, AutomationTaskStatus } from "./types.ts";
import {
  applyAutomationRuntime,
  applyOptimisticAutomationAction,
  automationTaskRowActions,
  parallelRunnableAutomationTaskIds,
} from "./task-row.ts";

function row(overrides: Partial<AutomationTaskRow> = {}): AutomationTaskRow {
  return {
    id: "post-statements",
    runId: "run-1",
    label: "Post",
    displayName: { en: "Post", "zh-TW": "中華郵政" },
    kind: "crawler",
    integrationNamespaces: [],
    credentialKeys: ["POST_ID"],
    dependencies: [],
    status: "completed",
    attempt: 1,
    maxAttempts: 2,
    latestStartedAt: null,
    latestFinishedAt: null,
    workflowProgress: null,
    appWorkflowOutcome: null,
    events: [],
    progressPercent: null,
    progressText: "Completed",
    humanSession: null,
    humanAssistanceContract: null,
    forceTerminateAvailable: false,
    isActive: false,
    ranToday: false,
    credentialsReady: true,
    primaryAction: "Run",
    canRun: true,
    ...overrides,
  };
}

function progress(percent: number | null) {
  return { phaseCode: "workflow-collection", completed: null, total: null, percent, attempt: 1 };
}

function runtime(overrides: Partial<AutomationRuntimeTaskSnapshot> = {}): AutomationRuntimeTaskSnapshot {
  return {
    taskId: "post-statements",
    runId: "run-1",
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    progress: progress(40),
    appWorkflowOutcome: null,
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

test("the primary action follows the lifecycle status, and only an active run ignores credentials", () => {
  const cases: Array<[AutomationTaskStatus, boolean, boolean, AutomationTaskRow["primaryAction"], boolean]> = [
    ["running", true, false, "Cancel", true],
    ["waiting_for_human", false, false, "Cancel", true],
    ["needs_setup", false, true, "Configure", true],
    ["locked", false, true, "Locked", false],
    ["failed", false, true, "Run again", true],
    ["failed", false, false, "Run again", false],
    ["completed", false, true, "Run", true],
    ["completed", false, false, "Run", false],
  ];
  for (const [status, isActive, credentialsReady, primaryAction, canRun] of cases) {
    assert.deepEqual(automationTaskRowActions(status, isActive, credentialsReady), { primaryAction, canRun }, `${status} ${isActive} ${credentialsReady}`);
  }
});

test("a runtime overlay keeps progress monotonic within a run and restarts it for a new run", () => {
  const source = row({ status: "running", isActive: true, progressPercent: 60 });
  assert.equal(applyAutomationRuntime(source, runtime({ progress: progress(30) })).progressPercent, 60);
  assert.equal(applyAutomationRuntime(source, runtime({ runId: "run-2", progress: progress(30) })).progressPercent, 30);
  assert.equal(applyAutomationRuntime(source, runtime({ progress: progress(120) })).progressPercent, 99);
  assert.equal(applyAutomationRuntime(source, runtime({ status: "completed", progress: progress(80) })).progressPercent, 100);
});

test("a finished runtime record recomputes the action from the row's credential readiness", () => {
  const source = row({ status: "running", isActive: true, primaryAction: "Cancel", canRun: true, credentialsReady: false });
  const finished = applyAutomationRuntime(source, runtime({ status: "failed" }));
  assert.equal(finished.primaryAction, "Run again");
  assert.equal(finished.canRun, false);
});

test("Sync all starts only idle, runnable tasks whose credentials are ready", () => {
  const rows = [
    row({ id: "ready" }),
    row({ id: "missing-credentials", credentialsReady: false, canRun: false }),
    row({ id: "active", isActive: true, status: "running", primaryAction: "Cancel" }),
    row({ id: "needs-setup", status: "needs_setup", primaryAction: "Configure" }),
    row({ id: "locked", status: "locked", primaryAction: "Locked", canRun: false }),
  ];
  assert.deepEqual(parallelRunnableAutomationTaskIds(rows), ["ready"]);
});

test("an optimistic run clears the previous run, and an optimistic cancel keeps it", () => {
  const source = row({ appWorkflowOutcome: { errorCode: "workflow-failed" } as AutomationTaskRow["appWorkflowOutcome"], events: [] });
  const running = applyOptimisticAutomationAction(source, "run");
  assert.equal(running.status, "preparing");
  assert.equal(running.appWorkflowOutcome, null);
  assert.equal(running.runId, null);
  const cancelling = applyOptimisticAutomationAction(row({ status: "running", isActive: true }), "cancel");
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.runId, "run-1");
});
