import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRuntimeSnapshot, AutomationRuntimeTaskSnapshot } from "../desktop/api.ts";
import type { AutomationActionPort } from "./automation-actions.ts";
import { createAutomationPageState, type AutomationReloadReason } from "./automation-page-state.ts";
import { createAutomationRuntimeRecovery, RUNTIME_RELOADED_KEY } from "./runtime-recovery.ts";
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
  };
  const state = createAutomationPageState({
    api,
    requestReload: (reason) => { calls.reloads.push(reason); },
    recovery: { failed: () => "reloading", accepted() {}, retry() {} },
    pollIntervalMs: 2_000,
  });
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

test("Stop all reaches a run that the runtime has not shown yet", async (t) => {
  const { state, calls, current } = harness(t);
  state.setModel(model([task({ id: "a" })]));
  const run = state.run("a")!;
  const stops = state.cancelAll([{ id: "a", status: "preparing" }]);
  assert.equal(stops.length, 1, "the pending run does not hide the task from Stop all");
  await Promise.all([run.settled, ...stops.map((stop) => stop.settled)]);
  assert.deepEqual(calls.cancel, ["a"]);
  assert.equal(row(current, "a").status, "cancelling");
  assert.equal(state.run("a"), null, "a pending stop still refuses a new run");
});

/** A tab's session storage, kept across the page states a test loads in it. */
function tab(options: { storageThrows?: boolean } = {}) {
  const items = new Map<string, string>();
  const window = {
    reloads: 0,
    items,
    storage: () => {
      if (options.storageThrows) throw new Error("storage is disabled");
      return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => { items.set(key, value); },
        removeItem: (key: string) => { items.delete(key); },
      };
    },
    reload: () => { window.reloads += 1; },
  };
  return window;
}

/** A page state whose runtime reads answer from a script, with push and resync sources the test fires. */
function connected(
  t: import("node:test").TestContext,
  reads: Array<AutomationRuntimeSnapshot | Error | Promise<AutomationRuntimeSnapshot>>,
  window = tab(),
) {
  t.mock.method(console, "error", () => {});
  const calls = { reads: 0 };
  const api: AutomationActionPort = {
    run: async (taskId) => ({ started: taskId }),
    runMany: async () => ({ started: [], results: {} }),
    cancel: async (taskId) => ({ cancelled: taskId }),
    forceTerminate: async (taskId) => ({ cancelled: taskId }),
    async runtimeSnapshot() {
      calls.reads += 1;
      const next = reads.shift();
      if (!next) throw new Error("no scripted read");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const state = createAutomationPageState({
    api,
    requestReload: () => {},
    recovery: createAutomationRuntimeRecovery({ storage: window.storage, reload: window.reload }),
  });
  let latest!: Parameters<Parameters<typeof state.subscribe>[0]>[0];
  const unsubscribe = state.subscribe((value) => { latest = value; });
  const push = new Set<(snapshot: AutomationRuntimeSnapshot) => void>();
  const resync = new Set<() => void>();
  const events = {
    runtimeChanged: (listener: (snapshot: AutomationRuntimeSnapshot) => void) => {
      push.add(listener);
      return () => push.delete(listener);
    },
    resync: (listener: () => void) => {
      resync.add(listener);
      return () => resync.delete(listener);
    },
  };
  t.after(() => {
    unsubscribe();
    state.dispose();
  });
  return {
    state,
    events,
    calls,
    revision: () => latest.runtime?.revision ?? null,
    unavailable: () => latest.runtimeUnavailable,
    pushSnapshot: (value: AutomationRuntimeSnapshot) => { for (const listener of [...push]) listener(value); },
    fireResync: () => { for (const listener of [...resync]) listener(); },
    listeners: () => push.size + resync.size,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("connecting reads the runtime once, then accepts every pushed snapshot", async (t) => {
  const page = connected(t, [snapshot(1, [])]);
  page.state.connect(page.events);
  await flush();
  assert.equal(page.calls.reads, 1);
  assert.equal(page.revision(), 1);
  page.pushSnapshot(snapshot(2, []));
  assert.equal(page.revision(), 2);
});

test("each resync reads the runtime again", async (t) => {
  const page = connected(t, [snapshot(1, []), snapshot(3, [])]);
  page.state.connect(page.events);
  await flush();
  page.fireResync();
  await flush();
  assert.equal(page.calls.reads, 2);
  assert.equal(page.revision(), 3);
});

test("a failed read reloads the window once, then shows the error state instead of reloading again", async (t) => {
  const window = tab();
  const first = connected(t, [new Error("bridge closed"), new Error("bridge closed")], window);
  first.state.connect(first.events);
  await flush();
  first.fireResync();
  await flush();
  assert.equal(window.reloads, 1, "a resync failing before the reload lands does not reload twice");
  assert.equal(first.unavailable(), false);

  const reloaded = connected(t, [new Error("bridge closed")], window);
  reloaded.state.connect(reloaded.events);
  await flush();
  assert.equal(window.reloads, 1, "the reloaded page does not reload by itself");
  assert.equal(reloaded.unavailable(), true);

  reloaded.state.retryRuntime();
  assert.equal(window.reloads, 2, "the person's retry reloads");

  const recovered = connected(t, [snapshot(1, []), new Error("bridge closed")], window);
  recovered.state.connect(recovered.events);
  await flush();
  assert.equal(recovered.unavailable(), false);
  assert.equal(window.items.has(RUNTIME_RELOADED_KEY), false, "an accepted snapshot forgets the reload");
  recovered.fireResync();
  await flush();
  assert.equal(window.reloads, 3, "a later failure may reload once again");
});

test("a snapshot the page cannot accept reloads like a failed read", async (t) => {
  const window = tab();
  const page = connected(t, [snapshot(1, [])], window);
  let thrown = false;
  page.state.subscribe((value) => {
    if (value.runtime && !thrown) {
      thrown = true;
      throw new Error("view failed");
    }
  });
  page.state.connect(page.events);
  await flush();
  assert.equal(window.reloads, 1);
});

test("without session storage the page shows the error state rather than risk a reload loop", async (t) => {
  const window = tab({ storageThrows: true });
  const page = connected(t, [new Error("bridge closed")], window);
  page.state.connect(page.events);
  await flush();
  assert.equal(window.reloads, 0);
  assert.equal(page.unavailable(), true);
});

test("an accepted snapshot clears the error state", async (t) => {
  const window = tab();
  window.items.set(RUNTIME_RELOADED_KEY, "1");
  const page = connected(t, [new Error("bridge closed")], window);
  page.state.connect(page.events);
  await flush();
  assert.equal(page.unavailable(), true);
  page.pushSnapshot(snapshot(1, []));
  assert.equal(page.unavailable(), false);
});

test("after dispose, neither a push nor a resync reaches the state", async (t) => {
  const page = connected(t, [snapshot(1, [])]);
  page.state.connect(page.events);
  await flush();
  page.state.dispose();
  assert.equal(page.listeners(), 0, "dispose ends the connection's subscriptions");
  page.fireResync();
  await flush();
  assert.equal(page.calls.reads, 1);
});

test("a snapshot that arrives after the connection ends is dropped", async (t) => {
  let answer!: (value: AutomationRuntimeSnapshot) => void;
  const page = connected(t, [new Promise<AutomationRuntimeSnapshot>((resolve) => { answer = resolve; })]);
  const disconnect = page.state.connect(page.events);
  disconnect();
  answer(snapshot(5, []));
  await flush();
  assert.equal(page.revision(), null);
});
