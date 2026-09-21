import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationBlockRefreshCoordinator, createAutomationRuntimeController } from "./runtime-controller.ts";
import { assertKnownAutomationRuntimeTasks, AutomationRuntimeInvariantError } from "./runtime-invariants.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";

const snapshot = (revision: number, status: "queued" | "running" | "completed" = "queued"): AutomationRuntimeSnapshot => ({
  sessionId: "session-1",
  revision,
  tasks: [{
    taskId: "task-1",
    runId: status === "queued" ? null : "run-1",
    status,
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: null, completed: null, total: null, percent: null, attempt: 1 },
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
