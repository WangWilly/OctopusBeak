import assert from "node:assert/strict";
import test from "node:test";
import {
  WAITING_SESSION_TIMEOUT_MS,
  armAutomationSessionTimeout,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
} from "./session-lifecycle.ts";

test("waiting timeout is exactly twenty minutes", () => {
  let delay = 0;
  armAutomationSessionTimeout("task-1", async () => {}, {
    setTimer(_callback, ms) { delay = ms; return 1; },
    clearTimer() {},
  });
  assert.equal(delay, WAITING_SESSION_TIMEOUT_MS);
  assert.equal(delay, 20 * 60 * 1_000);
});

test("rearming clears the prior timer with its owner", () => {
  let cleared = 0;
  armAutomationSessionTimeout("task-timer", async () => {}, {
    setTimer() { return 11; },
    clearTimer(timer) { cleared = Number(timer); },
  });
  armAutomationSessionTimeout("task-timer", async () => {}, {
    setTimer() { return 12; },
    clearTimer() {},
  });
  assert.equal(cleared, 11);
});

test("graceful close escalates only the owned daemon", async () => {
  const signals: NodeJS.Signals[] = [];
  let checks = 0;
  ownAutomationSession({ taskId: "task-1", taskRunId: "run-1", session: "ses-1", pid: 42 });
  await finalizeOwnedAutomationSession("task-1", {
    async closeSession() {},
    isExpectedDaemon(pid, session) {
      assert.equal(pid, 42);
      assert.equal(session, "ses-1");
      checks += 1;
      return checks < 2;
    },
    signalProcessGroup(pid, signal) { assert.equal(pid, 42); signals.push(signal); },
    async wait() {},
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(ownedAutomationSession("task-1"), null);
});

test("hung daemon escalates through SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  ownAutomationSession({ taskId: "task-2", taskRunId: "run-2", session: "ses-2", pid: 84 });
  await finalizeOwnedAutomationSession("task-2", {
    async closeSession() { throw new Error("IPC timeout"); },
    isExpectedDaemon() { return signals.length < 2; },
    signalProcessGroup(_pid, signal) { signals.push(signal); },
    async wait() {},
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("concurrent finalization closes once", async () => {
  let closeCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  ownAutomationSession({ taskId: "task-3", taskRunId: "run-3", session: "ses-3", pid: null });
  const deps = {
    async closeSession() { closeCalls += 1; await blocked; },
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    async wait() {},
  };
  const first = finalizeOwnedAutomationSession("task-3", deps);
  const second = finalizeOwnedAutomationSession("task-3", deps);
  release();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
});
