import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationActions, type AutomationActionPort } from "./automation-actions.ts";
import { createAutomationRuntimeController } from "./runtime-controller.ts";
import type { AutomationRuntimeSnapshot, AutomationRuntimeTaskSnapshot } from "../desktop/api.ts";

function runtime(revision: number, tasks: ReadonlyArray<Pick<AutomationRuntimeTaskSnapshot, "taskId" | "runId" | "status">>): AutomationRuntimeSnapshot {
  return {
    sessionId: "session-1",
    revision,
    tasks: tasks.map((task) => ({
      ...task,
      attempt: 1,
      maxAttempts: 1,
      progress: { phaseCode: null, completed: null, total: null, percent: 0, attempt: 1 },
      appWorkflowOutcome: null,
      updatedAt: "2026-10-24T12:00:00.000Z",
    })),
  };
}

type Calls = { run: string[]; runMany: string[][]; cancel: string[]; forceTerminate: string[]; snapshots: number; fatal: number };

function harness(overrides: Partial<AutomationActionPort> = {}) {
  const calls: Calls = { run: [], runMany: [], cancel: [], forceTerminate: [], snapshots: 0, fatal: 0 };
  const api: AutomationActionPort = {
    async run(taskId) {
      calls.run.push(taskId);
      return { started: taskId, runId: `run-${taskId}` };
    },
    async runMany(taskIds) {
      calls.runMany.push(taskIds);
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
      calls.snapshots += 1;
      return runtime(9, []);
    },
    async fatalRuntimeSnapshot() {
      calls.fatal += 1;
    },
    ...overrides,
  };
  const controller = createAutomationRuntimeController();
  const applied: AutomationRuntimeSnapshot[] = [];
  const actions = createAutomationActions({ controller, api, onSnapshot: (snapshot) => applied.push(snapshot) });
  return { calls, controller, actions, applied };
}

test("starting a run holds the task pending, binds its run and applies the response runtime", async () => {
  const response = runtime(1, [{ taskId: "a", runId: "run-a", status: "preparing" }]);
  const { controller, actions, applied } = harness({
    async run(taskId) {
      return { started: taskId, runId: "run-a", runtime: response };
    },
  });

  const start = actions.run("a");
  assert.ok(start);
  assert.deepEqual(start.taskIds, ["a"]);
  assert.deepEqual([...controller.pendingTaskIds()], ["a"]);
  assert.equal(actions.run("a"), null, "a pending task cannot start twice");

  assert.deepEqual(await start.settled, { runId: "run-a", error: null });
  assert.equal(controller.pendingActions()[0]?.runId, "run-a");
  assert.deepEqual(applied, [response]);
  actions.dispose();
});

test("a run that fails to start releases its task", async () => {
  const { controller, actions } = harness({
    async run() {
      throw new Error("credentials missing");
    },
  });
  const start = actions.run("a");
  assert.deepEqual(await start!.settled, { runId: null, error: "credentials missing" });
  assert.deepEqual([...controller.pendingTaskIds()], []);
  assert.ok(actions.run("a"), "the task can be started again");
  actions.dispose();
});

test("a run still preparing after the timeout reads the authoritative runtime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, actions, applied } = harness();
  await actions.run("a")!.settled;

  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.snapshots, 1);
  assert.equal(applied.at(-1)?.revision, 9);
  actions.dispose();
});

test("an unreadable runtime after the timeout asks for the fatal snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, actions } = harness({
    async runtimeSnapshot() {
      throw new Error("ipc closed");
    },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await actions.run("a")!.settled;
    t.mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.equal(calls.fatal, 1);
  actions.dispose();
});

test("no runtime read once the run appears or the start fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const appeared = harness();
  await appeared.actions.run("a")!.settled;
  appeared.controller.acceptSnapshot(runtime(1, [{ taskId: "a", runId: "run-a", status: "running" }]));

  const failed = harness({
    async run() {
      throw new Error("refused");
    },
  });
  await failed.actions.run("a")!.settled;

  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appeared.calls.snapshots, 0);
  assert.equal(failed.calls.snapshots, 0);
  appeared.actions.dispose();
  failed.actions.dispose();
});

test("a run queued behind others reads no runtime once a snapshot shows it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, controller, actions } = harness();
  controller.acceptSnapshot(runtime(1, [{ taskId: "a", runId: null, status: "completed" }]));
  await actions.runMany(["a"])!.settled;
  controller.acceptSnapshot(runtime(2, [{ taskId: "a", runId: "run-a", status: "queued" }]));
  assert.deepEqual([...controller.pendingTaskIds()], ["a"], "a queued run is still pending");

  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.snapshots, 0);
  actions.dispose();
});

test("dispose stops a pending runtime read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, actions } = harness();
  await actions.run("a")!.settled;
  actions.dispose();
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.snapshots, 0);
});

test("running many skips pending tasks, binds started runs and releases refused ones", async () => {
  const { calls, controller, actions } = harness({
    async runMany(taskIds) {
      calls.runMany.push(taskIds);
      return {
        started: ["b"],
        errors: { c: "source locked" },
        results: {
          b: { status: "started", runId: "run-b" },
          c: { status: "error", error: "source locked" },
        },
      };
    },
  });
  actions.run("a");

  const start = actions.runMany(["a", "b", "c"]);
  assert.ok(start);
  assert.deepEqual(start.taskIds, ["b", "c"]);
  assert.deepEqual(await start.settled, { errors: { c: "source locked" }, error: null });
  assert.deepEqual(calls.runMany, [["b", "c"]]);
  const pending = new Map(controller.pendingActions().map((action) => [action.taskId, action.runId]));
  assert.deepEqual([...pending.keys()].sort(), ["a", "b"]);
  assert.equal(pending.get("b"), "run-b");
  actions.dispose();
});

test("running many with every task pending starts nothing", () => {
  const { calls, actions } = harness();
  actions.run("a");
  assert.equal(actions.runMany(["a"]), null);
  assert.deepEqual(calls.runMany, []);
  actions.dispose();
});

test("a failed batch start releases every task it began", async () => {
  const { controller, actions } = harness({
    async runMany() {
      throw new Error("worker unavailable");
    },
  });
  const start = actions.runMany(["a", "b"]);
  assert.deepEqual(await start!.settled, { errors: {}, error: "worker unavailable" });
  assert.deepEqual([...controller.pendingTaskIds()], []);
  actions.dispose();
});

test("cancelling a run waiting for a person force-terminates it", async () => {
  const { calls, actions } = harness();
  assert.deepEqual(await actions.cancel({ id: "a", status: "waiting_for_human" })!.settled, { error: null });
  assert.deepEqual(await actions.cancel({ id: "b", status: "running" })!.settled, { error: null });
  assert.deepEqual(calls.forceTerminate, ["a"]);
  assert.deepEqual(calls.cancel, ["b"]);
  actions.dispose();
});

test("a refused stop releases its task, and a pending task cannot be stopped twice", async () => {
  const { controller, actions } = harness({
    async forceTerminate() {
      throw new Error("already finished");
    },
  });
  const stop = actions.forceTerminate("a");
  assert.equal(actions.cancel({ id: "a", status: "running" }), null);
  assert.deepEqual(await stop!.settled, { error: "already finished" });
  assert.deepEqual([...controller.pendingTaskIds()], []);
  actions.dispose();
});
