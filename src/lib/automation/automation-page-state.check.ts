import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRuntimeSnapshot, AutomationRuntimeTaskSnapshot } from "../desktop/api.ts";
import type { AutomationActionPort } from "./automation-actions.ts";
import { createAutomationPageState, type AutomationReloadReason } from "./automation-page-state.ts";
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";

function task(overrides: Partial<AutomationTaskRow> = {}): AutomationTaskRow {
  return {
    id: "exchange-rates",
    label: "Exchange rates",
    displayName: { en: "Exchange rates", "zh-TW": "匯率同步" },
    kind: "sync",
    integrationNamespaces: [],
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
    humanSession: null,
    humanAssistanceContract: null,
    forceTerminateAvailable: false,
    isActive: false,
    ranToday: false,
    credentialsReady: true,
    setupRequired: false,
    canonicalResetRequired: false,
    primaryAction: "Run",
    canRun: true,
    latestRunStatus: overrides.status ?? "queued",
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

function snapshot(revision: number, tasks: ReadonlyArray<Pick<AutomationRuntimeTaskSnapshot, "taskId" | "runId" | "status">>, sessionId = "session-1"): AutomationRuntimeSnapshot {
  return {
    sessionId,
    revision,
    tasks: tasks.map((entry) => ({
      ...entry,
      attempt: 1,
      maxAttempts: 1,
      progress: { phaseCode: null, completed: null, total: null, percent: 40, attempt: 1 },
      appWorkflowOutcome: null,
      updatedAt: "2026-10-24T12:00:00.000Z",
    })),
  };
}

function harness(t: import("node:test").TestContext) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const calls = { cancel: [] as string[], forceTerminate: [] as string[], reloads: [] as AutomationReloadReason[] };
  const api: AutomationActionPort = {
    async run(taskId) {
      return { started: taskId, runId: `run-${taskId}` };
    },
    async runMany(taskIds) {
      return { started: taskIds, results: Object.fromEntries(taskIds.map((id) => [id, { status: "started" as const, runId: `run-${id}` }])) };
    },
    async cancel(taskId) {
      calls.cancel.push(taskId);
      return { cancelled: taskId };
    },
    async forceTerminate(taskId) {
      calls.forceTerminate.push(taskId);
      return { cancelled: taskId };
    },
    async runtimeSnapshot() {
      return snapshot(1, []);
    },
    async fatalRuntimeSnapshot() {},
  };
  const state = createAutomationPageState({ api, requestReload: (reason) => calls.reloads.push(reason), pollIntervalMs: 2_000 });
  let latest!: Parameters<Parameters<typeof state.subscribe>[0]>[0];
  const unsubscribe = state.subscribe((value) => { latest = value; });
  t.after(() => {
    unsubscribe();
    state.dispose();
  });
  return { state, calls, current: () => latest };
}

const row = (current: () => { live: AutomationPageModel | null }, id: string) =>
  current().live!.tasks.find((entry) => entry.id === id)!;

test("Stop all holds every active row pending as cancelling until the runtime shows it", async (t) => {
  const { state, calls, current } = harness(t);
  state.setModel(model([task({ id: "a" }), task({ id: "b" })]));
  state.acceptSnapshot(snapshot(1, [{ taskId: "a", runId: "run-a", status: "running" }, { taskId: "b", runId: "run-b", status: "running" }]));
  const started = state.cancelAll(current().live!.tasks.filter((entry) => entry.isActive));
  assert.equal(started.length, 2);
  assert.deepEqual([...current().pendingTaskIds].sort(), ["a", "b"]);
  assert.equal(row(current, "a").status, "cancelling");
  await Promise.all(started.map((start) => start.settled));
  assert.deepEqual(calls.cancel.sort(), ["a", "b"]);
  assert.deepEqual(state.cancelAll(current().live!.tasks), [], "a pending task is not stopped twice");
  state.acceptSnapshot(snapshot(2, [{ taskId: "a", runId: "run-a", status: "cancelling" }, { taskId: "b", runId: "run-b", status: "cancelling" }]));
  assert.equal(current().pendingTaskIds.size, 0);
});

test("Stop all force-terminates a run that waits for a person", async (t) => {
  const { state, calls } = harness(t);
  const started = state.cancelAll([{ id: "a", status: "waiting_for_human" }, { id: "b", status: "running" }]);
  await Promise.all(started.map((start) => start.settled));
  assert.deepEqual(calls.forceTerminate, ["a"]);
  assert.deepEqual(calls.cancel, ["b"]);
});

test("a missed runtime revision or a new session asks for exactly one reload each", (t) => {
  const { state, calls } = harness(t);
  state.acceptSnapshot(snapshot(1, []));
  state.acceptSnapshot(snapshot(2, []));
  assert.deepEqual(calls.reloads, []);
  state.acceptSnapshot(snapshot(5, []));
  assert.deepEqual(calls.reloads, ["session-resync"], "revisions 3 and 4 were missed");
  state.acceptSnapshot(snapshot(4, []));
  assert.deepEqual(calls.reloads, ["session-resync"], "an older revision is ignored");
  state.acceptSnapshot(snapshot(1, [], "session-2"));
  assert.deepEqual(calls.reloads, ["session-resync", "session-resync"]);
});

test("a reloaded page model keeps the live runtime on its rows", (t) => {
  const { state, current } = harness(t);
  state.setModel(model([task({ id: "a" })]));
  state.acceptSnapshot(snapshot(1, [{ taskId: "a", runId: "run-a", status: "running" }]));
  state.setModel(model([task({ id: "a", status: "queued", displayName: { en: "Renamed", "zh-TW": "改名" } })]));
  assert.equal(row(current, "a").status, "running");
  assert.equal(row(current, "a").displayName.en, "Renamed", "static fields come from the new block");
});

test("the blocks refresh on a timer while work is active or pending, and stop once nothing is", async (t) => {
  const { state, calls } = harness(t);
  state.setModel(model([task({ id: "a" })]));
  t.mock.timers.tick(2_000);
  assert.deepEqual(calls.reloads, [], "idle: no refresh");
  const start = state.run("a")!;
  t.mock.timers.tick(2_000);
  assert.deepEqual(calls.reloads, ["poll"], "a pending run keeps refreshing before the runtime shows it");
  await start.settled;
  state.acceptSnapshot(snapshot(1, [{ taskId: "a", runId: "run-a", status: "running" }]));
  t.mock.timers.tick(2_000);
  assert.deepEqual(calls.reloads, ["poll", "poll"]);
  state.acceptSnapshot(snapshot(2, [{ taskId: "a", runId: "run-a", status: "completed" }]));
  t.mock.timers.tick(4_000);
  assert.deepEqual(calls.reloads, ["poll", "poll"], "a finished run stops the refresh");
});
