import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationBlockRefreshCoordinator, createAutomationRuntimeController } from "./runtime-controller.ts";
import { assertKnownAutomationRuntimeTasks, AutomationRuntimeInvariantError } from "./runtime-invariants.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";

const snapshot = (
  revision: number,
  status: "queued" | "running" | "completed" = "queued",
  runId = status === "queued" ? null : "run-1",
  percent: number | null = null,
): AutomationRuntimeSnapshot => ({
  sessionId: "session-1",
  revision,
  tasks: [{
    taskId: "task-1",
    runId,
    status,
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: null, completed: percent === null ? null : percent, total: percent === null ? null : 100, percent, attempt: 1 },
    statementFailures: [],
    logTail: "",
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  }],
});

test("runtime controller rejects stale events and detects revision gaps", () => {
  const controller = createAutomationRuntimeController();
  assert.equal(controller.acceptSnapshot(snapshot(1)).accepted, true);
  const gap = controller.acceptSnapshot(snapshot(3));
  assert.equal(gap.accepted, true);
  assert.equal(gap.hadGap, true);
  assert.equal(controller.acceptSnapshot(snapshot(2)).accepted, false);
});

test("revision gate rejects a late old-run snapshot after a newer run is accepted", () => {
  const controller = createAutomationRuntimeController();
  assert.equal(controller.acceptSnapshot(snapshot(10, "running", "run-new", 80)).accepted, true);
  const late = controller.acceptSnapshot(snapshot(9, "running", "run-old", 12));

  assert.equal(late.accepted, false);
  assert.equal(late.snapshot.tasks[0]?.runId, "run-new");
  assert.equal(late.snapshot.tasks[0]?.progress.percent, 80);
});

test("pending action is app-shell state and reconciles when a run appears", () => {
  const controller = createAutomationRuntimeController();
  const token = controller.beginAction("task-1", "run");
  assert.ok(token);
  assert.equal(controller.beginAction("task-1", "run"), null);
  controller.bindRun(token!, "run-1");
  controller.acceptSnapshot(snapshot(1, "running"));
  assert.deepEqual([...controller.pendingTaskIds()], []);
});

test("block refresh is single-flight with one trailing refresh", async () => {
  let reads = 0;
  let release!: () => void;
  const first = new Promise<number>((resolve) => { release = () => resolve(++reads); });
  const coordinator = createAutomationBlockRefreshCoordinator(async () => {
    if (reads === 0) return first;
    return ++reads;
  });
  const a = coordinator.refresh("route-entry");
  const b = coordinator.refresh("overtaken");
  assert.strictEqual(a, b);
  release();
  assert.equal(await a, 2);
  assert.equal(reads, 2);
});

test("a trailing refresh does not recursively chase newer revisions", async () => {
  let calls = 0;
  let release!: () => void;
  const first = new Promise<void>((resolve) => { release = resolve; });
  let coordinator: ReturnType<typeof createAutomationBlockRefreshCoordinator<number>>;
  coordinator = createAutomationBlockRefreshCoordinator(async (isTrailing) => {
    calls += 1;
    if (!isTrailing) {
      await first;
      return calls;
    }
    // A stale trailing response must not create a second trailing request.
    coordinator.refresh("overtaken", async () => {
      calls += 1;
      return calls;
    });
    return calls;
  });
  const result = coordinator.refresh("route-entry");
  coordinator.refresh("overtaken");
  release();
  assert.equal(await result, 2);
  assert.equal(calls, 2);
});

test("unknown active task raises a safe fatal invariant while terminal rows are allowed", () => {
  const known = new Set(["known"]);
  assert.throws(
    () => assertKnownAutomationRuntimeTasks({ ...snapshot(1), tasks: [{ ...snapshot(1).tasks[0]!, taskId: "unknown" }] }, known),
    (error: unknown) => error instanceof AutomationRuntimeInvariantError
      && error.details.taskId === "unknown"
      && error.details.runId === null,
  );
  assert.doesNotThrow(() => assertKnownAutomationRuntimeTasks({
    ...snapshot(1),
    tasks: [{ ...snapshot(1).tasks[0]!, taskId: "unknown", status: "completed", runId: "run-old" }],
  }, known));
});
