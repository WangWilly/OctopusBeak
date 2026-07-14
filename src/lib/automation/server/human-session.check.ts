import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { forceQuitHumanSessionForTask, humanSessionFromRun } from "./human-session.ts";
import {
  finalizeExactOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
} from "./session-lifecycle.ts";
import { createTaskRun, taskRunById } from "./store.ts";

assert.equal(
  humanSessionFromRun({
    status: "waiting_for_human",
    logTail: "Workflow paused. run `npx libretto resume --session ses-1p4q`.",
  }, "demo-task"),
  "ses-1p4q",
);

assert.throws(
  () => humanSessionFromRun({ status: "completed", logTail: "" }, "demo-task"),
  /not waiting for human input/,
);

assert.throws(
  () => humanSessionFromRun({ status: "waiting_for_human", logTail: "paused" }, "demo-task"),
  /Missing Libretto resume session/,
);

test("force quit persists failure before surfacing cleanup failure", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-force-quit-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createTaskRun(db, {
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: join(ledgerDir, "force-quit.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-force-quit`.",
    });
    db.close();

    await assert.rejects(
      forceQuitHumanSessionForTask("fubon-all-statements", ledgerDir, {
        readSessionState() { throw new Error("state unavailable"); },
      }),
      /state unavailable/,
    );

    const verifiedDb = openLedgerDatabase(ledgerDir, { readOnly: true });
    const stored = taskRunById(verifiedDb, run.taskRunId);
    verifiedDb.close();
    assert.equal(stored?.status, "failed");
    assert.match(stored?.errorMessage ?? "", /^Browser session force quit\./);
    assert.match(stored?.errorMessage ?? "", /Session cleanup failed: state unavailable/);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("force quit leaves a resumed owner untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-force-quit-owner-"));
  const newer = {
    taskId: "fubon-all-statements",
    taskRunId: "new-run",
    session: "ses-new",
  };
  try {
    const db = openLedgerDatabase(ledgerDir);
    const old = createTaskRun(db, {
      taskId: newer.taskId,
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: join(ledgerDir, "force-quit-owner.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-old`.",
    });
    db.close();
    ownAutomationSession({ ...newer, pid: null });

    await assert.rejects(
      forceQuitHumanSessionForTask(newer.taskId, ledgerDir, {
        readSessionState() { return null; },
      }),
      /ownership changed/,
    );

    assert.equal(ownedAutomationSession(newer.taskId)?.taskRunId, newer.taskRunId);
    const verifiedDb = openLedgerDatabase(ledgerDir, { readOnly: true });
    assert.match(
      taskRunById(verifiedDb, old.taskRunId)?.errorMessage ?? "",
      /Session cleanup failed: Automation session ownership changed/,
    );
    verifiedDb.close();
  } finally {
    await finalizeExactOwnedAutomationSession(newer, {
      async closeSession() {},
      isExpectedDaemon() { return false; },
      signalProcessGroup() {},
      async wait() {},
    });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
