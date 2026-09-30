import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";
import {
  isAutomationBlockStale,
  mergeAutomationRuntime,
  mergeAutomationRuntimeTask,
  selectAutomationBlockModel,
} from "./runtime-sync.ts";

function task(overrides: Partial<AutomationTaskRow> = {}): AutomationTaskRow {
  return {
    id: "exchange-rates",
    label: "Exchange rates",
    kind: "sync",
    credentialKeys: [],
    dependencies: [],
    status: "queued",
    attempt: 0,
    maxAttempts: 1,
    latestStartedAt: null,
    latestFinishedAt: null,
    appWorkflowOutcome: null,
    events: [],
    progressPercent: null,
    progressText: "Queued",
    humanSession: null,
    humanAssistanceContract: null,
    forceTerminateAvailable: false,
    isActive: false,
    ranToday: false,
    primaryAction: "Run",
    canRun: true,
    ...overrides,
  };
}

function model(tasks: AutomationTaskRow[]): AutomationPageModel {
  return {
    businessDate: "2026-09-21",
    active: false,
    activeTaskCount: 0,
    parallelRunnableTaskIds: tasks.map((item) => item.id),
    credentials: {},
    externalPrerequisiteNotices: [],
    tasks,
  };
}

function runtime(overrides: Partial<AutomationRuntimeSnapshot> = {}): AutomationRuntimeSnapshot {
  return {
    sessionId: "session-1",
    revision: 4,
    tasks: [{
      taskId: "exchange-rates",
      runId: "run-1",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      progress: {
        phaseCode: "fetch",
        completed: 2,
        total: 4,
        percent: 50,
        attempt: 1,
      },
      appWorkflowOutcome: null,
      forceTerminateAvailable: false,
      updatedAt: "2026-09-21T00:00:00.000Z",
    }],
    ...overrides,
  };
}

test("runtime merge gives live status, progress, outcome, and action precedence", () => {
  const merged = mergeAutomationRuntime(model([task()]), runtime());
  const item = merged.tasks[0]!;
  assert.equal(item.status, "running");
  assert.equal(item.isActive, true);
  assert.equal(item.progressPercent, 50);
  assert.equal(item.progressText, "50%");
  assert.equal(item.appWorkflowOutcome, null);
  assert.equal("logTail" in item, false);
  assert.equal(item.primaryAction, "Cancel");
  assert.equal(item.canRun, true);
  assert.equal(merged.activeTaskCount, 1);
  assert.deepEqual(merged.parallelRunnableTaskIds, []);
});

test("block metadata remains the static source while runtime overlay is authoritative", () => {
  const fallback = model([task({ label: "fallback" })]);
  const block = model([task({ label: "block" })]);
  const merged = selectAutomationBlockModel(fallback, block, runtime());
  assert.equal(merged.tasks[0]?.label, "block");
  assert.equal(merged.tasks[0]?.status, "running");
  assert.equal(merged.tasks[0]?.appWorkflowOutcome, null);
});

test("stale detection compares the captured session and revision", () => {
  const current = runtime({ revision: 9 });
  assert.equal(isAutomationBlockStale({ runtimeSessionId: "session-1", runtimeRevision: 8 }, current), true);
  assert.equal(isAutomationBlockStale({ runtimeSessionId: "session-1", runtimeRevision: 9 }, current), false);
  assert.equal(isAutomationBlockStale({ runtimeSessionId: "old-session", runtimeRevision: 1 }, current), false);
});

test("terminal runtime fields do not mutate the source block", () => {
  const source = task();
  const merged = mergeAutomationRuntimeTask(source, {
    ...runtime().tasks[0]!,
    status: "completed",
    progress: { ...runtime().tasks[0]!.progress, percent: 100 },
  });
  assert.equal(source.status, "queued");
  assert.equal(merged.status, "completed");
  assert.equal(merged.progressPercent, 100);
});

test("terminal runtime status derives the current action instead of stale block action", () => {
  const source = task({
    status: "running",
    isActive: true,
    primaryAction: "Cancel",
    canRun: true,
  });
  const completed = mergeAutomationRuntimeTask(source, {
    ...runtime().tasks[0]!,
    status: "completed",
    progress: { ...runtime().tasks[0]!.progress, percent: 100 },
  });
  const partial = mergeAutomationRuntimeTask(source, {
    ...runtime().tasks[0]!,
    status: "partial",
    progress: { ...runtime().tasks[0]!.progress, percent: 67 },
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.isActive, false);
  assert.equal(completed.primaryAction, "Run");
  assert.equal(completed.progressPercent, 100);
  assert.equal(partial.status, "partial");
  assert.equal(partial.isActive, false);
  assert.equal(partial.primaryAction, "Run");
  assert.equal(partial.progressPercent, 67);
});

test("runtime updates carry the durable typed outcome into the row", () => {
  const source = task();
  const partialRuntime = {
    ...runtime().tasks[0]!,
    status: "partial" as const,
    progress: { ...runtime().tasks[0]!.progress, percent: 100 },
    appWorkflowOutcome: {
      errorCode: null,
      summary: { status: "partial" as const, counts: { skippedProductCount: 1, itemCount: 2 } },
    },
  };
  const merged = mergeAutomationRuntimeTask(source, partialRuntime);

  assert.deepEqual(merged.appWorkflowOutcome, partialRuntime.appWorkflowOutcome);
});

test("a newer terminal run replaces a stale terminal block row", () => {
  const source = {
    ...task({
      status: "completed",
      isActive: false,
      runId: "run-old",
      progressPercent: 100,
      progressText: "100%",
      primaryAction: "Run",
    }),
  };
  const runtimeTask = {
    ...runtime().tasks[0]!,
    runId: "run-new",
    status: "completed" as const,
    progress: { ...runtime().tasks[0]!.progress, percent: 100 },
    appWorkflowOutcome: {
      errorCode: null,
      summary: { status: "completed" as const, counts: { itemCount: 3 } },
    },
  };
  const merged = mergeAutomationRuntimeTask(source, runtimeTask);

  assert.equal(merged.runId, "run-new");
  assert.equal(merged.status, "completed");
  assert.equal(merged.progressPercent, 100);
  assert.deepEqual(merged.appWorkflowOutcome, runtimeTask.appWorkflowOutcome);
});

test("an accepted active snapshot replaces a stale active block row", () => {
  const source = {
    ...task({
      status: "running",
      isActive: true,
      runId: "run-old",
      progressPercent: 18,
      progressText: "18%",
      primaryAction: "Cancel",
    }),
  };
  const runtimeTask = {
    ...runtime().tasks[0]!,
    runId: "run-new",
    status: "running" as const,
    progress: { ...runtime().tasks[0]!.progress, percent: 42 },
  };
  const merged = mergeAutomationRuntimeTask(source, runtimeTask);

  assert.equal(merged.runId, "run-new");
  assert.equal(merged.status, "running");
  assert.equal(merged.progressPercent, 42);
  assert.equal(merged.progressText, "42%");
  assert.equal(merged.appWorkflowOutcome, null);
});

test("each task receives only its own run progress update", () => {
  const source = model([
    task({ id: "task-a", progressPercent: 10, progressText: "10%" }),
    task({ id: "task-b", progressPercent: 80, progressText: "80%" }),
  ]);
  const merged = mergeAutomationRuntime(source, {
    sessionId: "session-1",
    revision: 10,
    tasks: [
      {
        ...runtime().tasks[0]!,
        taskId: "task-a",
        runId: "run-a",
        progress: { ...runtime().tasks[0]!.progress, percent: 25 },
      },
      {
        ...runtime().tasks[0]!,
        taskId: "task-b",
        runId: "run-b",
        progress: { ...runtime().tasks[0]!.progress, percent: 80 },
      },
    ],
  });

  assert.equal(merged.tasks.find((item) => item.id === "task-a")?.progressPercent, 25);
  assert.equal(merged.tasks.find((item) => item.id === "task-b")?.progressPercent, 80);
});
