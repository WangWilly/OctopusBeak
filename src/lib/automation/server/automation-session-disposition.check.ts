import assert from "node:assert/strict";
import test from "node:test";
import {
  automationSessionFromLog,
  claimAutomationTaskRunSession,
  isLiveOwnedAutomationSession,
  resumeSessionFromLog,
  sessionFromRun,
} from "./automation-session-disposition.ts";
import {
  finalizeExactOwnedAutomationSession,
  ownedAutomationSession,
} from "./session-lifecycle.ts";
import type { AutomationPersistencePort, AutomationTaskRun } from "./store.ts";

test("session identity parsing uses the latest appended identity", () => {
  const output = "automation-session: ses-first\nlibretto resume --session ses-second";
  assert.equal(automationSessionFromLog(output), "ses-first");
  assert.equal(resumeSessionFromLog(output), "ses-second");
  assert.equal(
    sessionFromRun({
      taskId: "task",
      taskRunId: "run",
      script: "run:task",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: null,
      exitCode: null,
      signal: null,
      errorMessage: null,
      logPath: "/missing/automation.log",
    logTail: "libretto resume --session ses-second",
      recordJson: "{}",
      humanAssistanceContract: null,
    }),
    "ses-second",
  );
});

test("live session recovery requires paused identity, expected daemon, and endpoint", async () => {
  const owner = { taskId: "task", taskRunId: "run", session: "ses-live", pid: 52 };
  const result = await isLiveOwnedAutomationSession(owner, {
    readSessionState: () => ({ session: "ses-live", status: "paused", pid: 52, port: 9222 }),
    isExpectedDaemon: () => true,
    endpointForSession: () => "http://127.0.0.1:9222",
    probeEndpoint: async () => true,
  });
  assert.equal(result, true);
  assert.equal(await isLiveOwnedAutomationSession(owner, {
    readSessionState: () => ({ session: "ses-other", status: "paused", pid: 52, port: 9222 }),
    isExpectedDaemon: () => true,
    endpointForSession: () => "http://127.0.0.1:9222",
    probeEndpoint: async () => true,
  }), false);
});

test("resume handoff transitions its source through the injected provider before claiming", async () => {
  const taskId = "session-handoff-check";
  const oldRun = {
    taskId,
    taskRunId: "old-run",
    script: "run:task",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-23T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    logPath: "/missing/automation.log",
    logTail: "libretto resume --session ses-handoff",
    recordJson: "{}",
    humanAssistanceContract: null,
  } as AutomationTaskRun;
  const runs = new Map<string, AutomationTaskRun>([[oldRun.taskRunId, oldRun]]);
  const persistence = {
    async taskRunById(taskRunId: string) {
      return runs.get(taskRunId) ?? null;
    },
    async transitionTaskRunToTerminal(taskRunId: string, update: { status: AutomationTaskRun["status"] }) {
      const run = runs.get(taskRunId);
      if (!run || run.status === "completed" || run.status === "partial" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted") {
        return { status: run?.status ?? "failed", applied: false };
      }
      runs.set(taskRunId, { ...run, ...update });
      return { status: update.status, applied: true };
    },
  } as unknown as AutomationPersistencePort;
  const owner = { taskId, taskRunId: "new-run", session: "ses-handoff", pid: null };
  try {
    assert.equal(await claimAutomationTaskRunSession(
      persistence,
      owner.taskRunId,
      owner,
      { resumeSession: owner.session, resumeFrom: oldRun },
    ), true);
    assert.equal(runs.get(oldRun.taskRunId)?.status, "failed");
    assert.equal(ownedAutomationSession(taskId)?.taskRunId, owner.taskRunId);
  } finally {
    await finalizeExactOwnedAutomationSession(owner, {
      async closeSession() {},
      isExpectedDaemon: () => false,
      signalProcessGroup() {},
      async wait() {},
    });
  }
});
