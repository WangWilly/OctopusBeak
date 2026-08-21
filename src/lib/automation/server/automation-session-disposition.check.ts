import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  automationSessionOwnerForRun,
  claimAutomationTaskRunSession,
  finalizeAutomationSessionForRun,
  isLiveOwnedAutomationSession,
  ownedAutomationSessionForTask,
  refreshAutomationSession,
  relinquishAutomationSessionForTask,
  resumeSessionFromLog,
  type OwnedAutomationSession,
} from "./automation-session-disposition.ts";
import { createTaskRun, taskRunById } from "./store.ts";

function createRun(
  db: ReturnType<typeof openLedgerDatabase>,
  ledgerDir: string,
  status: "running" | "waiting_for_human" = "running",
  logTail = "",
) {
  const run = createTaskRun(db, {
    taskId: "fubon-all-statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    status,
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
    logPath: join(ledgerDir, `${status}-${Math.random()}.log`),
    logTail,
  });
  return taskRunById(db, run.taskRunId)!;
}

function fakeFinalizeDeps() {
  return {
    async closeSession() {},
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    async wait() {},
  };
}

test("session owner resolution reads the bounded log prefix before the tail", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-session-disposition-owner-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createRun(db, ledgerDir, "running", "tail does not contain the identity");
    writeFileSync(run.logPath, "automation-session: ses-prefix\n" + "x".repeat(10_000));
    assert.deepEqual(automationSessionOwnerForRun(run), {
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      session: "ses-prefix",
      pid: null,
    });
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("resume session parsing accepts Libretto resume output", () => {
  assert.equal(
    resumeSessionFromLog('Resume requested for session "ses-resume-output".'),
    "ses-resume-output",
  );
});

test("live session recovery requires exact daemon identity and a loopback CDP probe", async () => {
  const owner = { session: "ses-live-check", pid: 4242 };
  const state = { session: owner.session, port: 49321, pid: owner.pid, status: "paused" };
  const dependencies = {
    readSessionState: () => state,
    endpointForSession: () => "http://127.0.0.1:49321",
    isExpectedDaemon: (pid: number, session: string) => pid === owner.pid && session === owner.session,
    probeEndpoint: async () => true,
  };
  assert.equal(await isLiveOwnedAutomationSession(owner, dependencies), true);
  assert.equal(await isLiveOwnedAutomationSession({ ...owner, pid: 4243 }, dependencies), false);
  assert.equal(
    await isLiveOwnedAutomationSession(owner, {
      ...dependencies,
      endpointForSession: () => "https://127.0.0.1:49321",
    }),
    false,
  );
  assert.equal(
    await isLiveOwnedAutomationSession(owner, {
      ...dependencies,
      probeEndpoint: async () => false,
    }),
    false,
  );
  assert.equal(
    await isLiveOwnedAutomationSession(owner, {
      ...dependencies,
      probeEndpoint: async () => { throw new Error("probe unavailable"); },
    }),
    false,
  );
});

test("resume handoff finalizes the old run and claims the new session atomically", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-session-disposition-handoff-"));
  let owner: OwnedAutomationSession | null = null;
  try {
    const db = openLedgerDatabase(ledgerDir);
    const waiting = createRun(
      db,
      ledgerDir,
      "waiting_for_human",
      "Workflow paused. run `npx libretto resume --session ses-handoff`.",
    );
    const next = createRun(db, ledgerDir, "running");
    owner = {
      taskId: next.taskId,
      taskRunId: next.taskRunId,
      session: "ses-handoff",
      pid: null,
    };
    refreshAutomationSession({
      taskId: waiting.taskId,
      taskRunId: waiting.taskRunId,
      session: "ses-handoff",
      pid: null,
    });

    assert.equal(
      claimAutomationTaskRunSession(db, next.taskRunId, owner, {
        resumeSession: owner.session,
        resumeFrom: waiting,
      }),
      true,
    );
    assert.equal(taskRunById(db, waiting.taskRunId)?.status, "failed");
    assert.equal(ownedAutomationSessionForTask(next.taskId)?.taskRunId, next.taskRunId);
    db.close();
  } finally {
    if (owner) await relinquishAutomationSessionForTask(owner.taskId, fakeFinalizeDeps());
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("recovery reports missing identity without guessing a session", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-session-disposition-recovery-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createRun(db, ledgerDir, "running", "workflow failed without session metadata");
    const result = await finalizeAutomationSessionForRun(run, "workflow failed", "recovery");
    assert.deepEqual(result, {
      session: null,
      pid: null,
      errorMessage: "workflow failed\nSession cleanup failed: Missing Libretto session identity",
      cleanupFailed: true,
    });
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("exact finalization refuses a changed owner without cleanup", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-session-disposition-owner-race-"));
  const owner = {
    taskId: "fubon-all-statements",
    taskRunId: "new-owner",
    session: "ses-new-owner",
    pid: null,
  } satisfies OwnedAutomationSession;
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createRun(db, ledgerDir, "running", "automation-session: ses-old-owner");
    refreshAutomationSession(owner);
    const result = await finalizeAutomationSessionForRun(run, "workflow completed", "exact");
    assert.equal(result.cleanupFailed, true);
    assert.match(result.errorMessage ?? "", /ownership changed/);
    assert.equal(ownedAutomationSessionForTask(owner.taskId)?.taskRunId, owner.taskRunId);
    db.close();
  } finally {
    await relinquishAutomationSessionForTask(owner.taskId, fakeFinalizeDeps());
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
