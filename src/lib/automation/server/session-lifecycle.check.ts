import assert from "node:assert/strict";
import test from "node:test";
import {
  WAITING_SESSION_TIMEOUT_MS,
  armAutomationSessionTimeout,
  claimAutomationSessionForCleanup,
  finalizeExactOwnedAutomationSession,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
  signalProcessGroup,
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

test("never-settling graceful close is terminated before exact daemon escalation", async () => {
  const signals: NodeJS.Signals[] = [];
  let terminatedSession = "";
  let checks = 0;
  ownAutomationSession({
    taskId: "task-close-timeout",
    taskRunId: "run-close-timeout",
    session: "ses-close-timeout",
    pid: 126,
  });
  const finalizing = finalizeOwnedAutomationSession("task-close-timeout", {
    closeSession: () => new Promise<void>(() => {}),
    terminateCloseSession(session) { terminatedSession = session; },
    isExpectedDaemon(pid, session) {
      assert.equal(pid, 126);
      assert.equal(session, "ses-close-timeout");
      checks += 1;
      return checks < 2;
    },
    signalProcessGroup(_pid, signal) { signals.push(signal); },
    async wait() {},
    timerDeps: {
      setTimer(callback) {
        if (terminatedSession === "") callback();
        return 100;
      },
      clearTimer() {},
    },
  });

  await Promise.race([
    finalizing,
    new Promise((_, reject) => setImmediate(() => reject(new Error("close deadline did not fire")))),
  ]);
  assert.equal(terminatedSession, "ses-close-timeout");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("successful graceful close cancels its exact deadline", async () => {
  let cleared: NodeJS.Timeout | number | undefined;
  ownAutomationSession({
    taskId: "task-close-deadline-clear",
    taskRunId: "run-close-deadline-clear",
    session: "ses-close-deadline-clear",
    pid: null,
  });
  await finalizeOwnedAutomationSession("task-close-deadline-clear", {
    async closeSession() {},
    startCloseSession: () => ({ completion: Promise.resolve(), async terminate() {} }),
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    async wait() {},
    timerDeps: {
      setTimer() { return 101; },
      clearTimer(timer) { cleared = timer; },
    },
  });
  assert.equal(cleared, 101);
});

test("close timeout awaits exact helper exit before daemon escalation", async () => {
  const events: string[] = [];
  let fireDeadline: (() => void) | undefined;
  let releaseTermination!: () => void;
  const termination = new Promise<void>((resolve) => { releaseTermination = resolve; });
  const terminate = async () => {
    events.push("terminate-start");
    await termination;
    events.push("terminate-done");
  };
  ownAutomationSession({
    taskId: "task-close-await-exit",
    taskRunId: "run-close-await-exit",
    session: "ses-close-await-exit",
    pid: 127,
  });
  const finalizing = finalizeOwnedAutomationSession("task-close-await-exit", {
    closeSession: () => new Promise<void>(() => {}),
    terminateCloseSession: terminate,
    startCloseSession: () => ({
      completion: new Promise<void>(() => {}),
      terminate,
    }),
    isExpectedDaemon() { events.push("verify-daemon"); return events.filter((event) => event === "verify-daemon").length < 2; },
    signalProcessGroup(_pid, signal) { events.push(signal); },
    async wait() {},
    timerDeps: {
      setTimer(callback) { fireDeadline = callback; return 102; },
      clearTimer() {},
    },
  });

  fireDeadline?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["terminate-start"]);
  releaseTermination();
  await finalizing;
  assert.deepEqual(events, ["terminate-start", "terminate-done", "verify-daemon", "SIGTERM", "verify-daemon"]);
});

test("helper termination timeout rejects even when the owned daemon is absent", async () => {
  const deadlines: Array<() => void> = [];
  ownAutomationSession({
    taskId: "task-helper-timeout-error",
    taskRunId: "run-helper-timeout-error",
    session: "ses-helper-timeout-error",
    pid: 128,
  });
  const finalizing = finalizeOwnedAutomationSession("task-helper-timeout-error", {
    closeSession: () => new Promise<void>(() => {}),
    startCloseSession: () => ({
      completion: new Promise<void>(() => {}),
      terminate: () => new Promise<void>(() => {}),
    }),
    isExpectedDaemon(pid, session) {
      assert.equal(pid, 128);
      assert.equal(session, "ses-helper-timeout-error");
      return false;
    },
    signalProcessGroup() { assert.fail("absent daemon must not be signalled"); },
    async wait() {},
    timerDeps: {
      setTimer(callback) { deadlines.push(callback); return deadlines.length; },
      clearTimer() {},
    },
  });

  deadlines.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  deadlines.shift()?.();
  await assert.rejects(finalizing, /close helper remained/i);
  assert.equal(ownedAutomationSession("task-helper-timeout-error"), null);
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
    wait: () => new Promise<void>(() => {}),
  };
  const first = finalizeOwnedAutomationSession("task-3", deps);
  const second = finalizeOwnedAutomationSession("task-3", deps);
  release();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
});

test("closing session refuses ownership from a new run", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const oldOwner = { taskId: "task-in-flight", taskRunId: "run-old", session: "ses-in-flight" };
  ownAutomationSession({ ...oldOwner, pid: null });
  const closing = finalizeExactOwnedAutomationSession(oldOwner, {
    async closeSession() { await blocked; },
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    wait: () => new Promise<void>(() => {}),
  });

  assert.equal(ownAutomationSession({
    taskId: oldOwner.taskId,
    taskRunId: "run-new",
    session: oldOwner.session,
    pid: null,
  }), false);
  assert.equal(ownedAutomationSession(oldOwner.taskId)?.taskRunId, oldOwner.taskRunId);
  release();
  await closing;
});

test("exact-owner finalization leaves a replacement registered", async () => {
  let closeCalls = 0;
  ownAutomationSession({ taskId: "task-exact", taskRunId: "run-new", session: "ses-new", pid: null });
  const finalized = await finalizeExactOwnedAutomationSession(
    { taskId: "task-exact", taskRunId: "run-old", session: "ses-old" },
    {
      async closeSession() { closeCalls += 1; },
      isExpectedDaemon() { return false; },
      signalProcessGroup() {},
      async wait() {},
    },
  );
  assert.equal(finalized, false);
  assert.equal(closeCalls, 0);
  assert.equal(ownedAutomationSession("task-exact")?.taskRunId, "run-new");
});

test("old timeout cannot close a resumed owner", async () => {
  let timeout!: () => void;
  let closeCalls = 0;
  const oldOwner = { taskId: "task-resume", taskRunId: "run-old", session: "ses-shared" };
  ownAutomationSession({ ...oldOwner, pid: null });
  armAutomationSessionTimeout("task-resume", async () => {
    await finalizeExactOwnedAutomationSession(oldOwner, {
      async closeSession() { closeCalls += 1; },
      isExpectedDaemon() { return false; },
      signalProcessGroup() {},
      async wait() {},
    });
  }, {
    setTimer(callback) { timeout = callback; return 21; },
    clearTimer() {},
  });
  ownAutomationSession({ taskId: "task-resume", taskRunId: "run-new", session: "ses-shared", pid: null });
  timeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  assert.equal(ownedAutomationSession("task-resume")?.taskRunId, "run-new");
});

test("cleanup claim refuses a different owner", () => {
  ownAutomationSession({ taskId: "task-claim", taskRunId: "run-new", session: "ses-new", pid: 7 });
  assert.equal(claimAutomationSessionForCleanup({
    taskId: "task-claim",
    taskRunId: "run-old",
    session: "ses-old",
    pid: null,
  }), false);
  assert.equal(ownedAutomationSession("task-claim")?.taskRunId, "run-new");
});

test("state read failure does not prevent graceful close", async () => {
  let closeCalls = 0;
  ownAutomationSession({ taskId: "task-bad-state", taskRunId: "run-bad-state", session: "../bad-state", pid: null });
  await finalizeOwnedAutomationSession("task-bad-state", {
    async closeSession() { closeCalls += 1; },
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    async wait() {},
  });
  assert.equal(closeCalls, 1);
});

test("state read and graceful close failures retain both contexts", async () => {
  ownAutomationSession({ taskId: "task-double-failure", taskRunId: "run-double-failure", session: "../double-failure", pid: null });
  await assert.rejects(
    finalizeOwnedAutomationSession("task-double-failure", {
      async closeSession() { throw new Error("graceful close failed"); },
      isExpectedDaemon() { return false; },
      signalProcessGroup() {},
      async wait() {},
    }),
    (error: Error) => {
      assert.match(error.message, /Invalid Libretto session/);
      assert.match(error.message, /graceful close failed/);
      return true;
    },
  );
});

test("signal succeeds when group and process both disappear", () => {
  const originalKill = process.kill;
  const attemptedPids: number[] = [];
  process.kill = ((pid: number) => {
    attemptedPids.push(pid);
    const error = new Error("gone") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }) as typeof process.kill;
  try {
    signalProcessGroup(42, "SIGTERM");
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(attemptedPids, [-42, 42]);
});
