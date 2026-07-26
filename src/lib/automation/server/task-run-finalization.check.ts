import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { statementRunSummaryLine } from "../statement-run-summary.ts";
import {
  activeTaskRuns,
  createTaskRun,
  taskRunById,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import {
  finalizeAutomationTaskRun,
  finalizePersistedRun,
  type AutomationTaskProcessResult,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";

function createExecution(ledgerDir: string) {
  const db = openLedgerDatabase(ledgerDir);
  const task = taskById("exchange-rates")!;
  const logPath = join(ledgerDir, "automation.log");
  const run = createTaskRun(db, {
    taskId: task.id,
    script: "run:exchange-rates",
    kind: task.kind,
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
    logPath,
  });
  const execution = {
    task,
    taskDb: db,
    run: { taskRunId: run.taskRunId },
    logPath,
    command: {},
    session: null,
    owner: null,
  } as AutomationTaskRunExecution;
  return { db, run, execution };
}

function result(overrides: Partial<AutomationTaskProcessResult> = {}): AutomationTaskProcessResult {
  return {
    exitCode: 0,
    signal: null,
    error: null,
    logTail: "",
    resumeFailure: null,
    statementSummary: null,
    outputPersistenceWarnings: [],
    ...overrides,
  };
}

test("live finalization persists a partial statement outcome through one transition", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-live-"));
  try {
    const { db, run, execution } = createExecution(ledgerDir);
    const summary = {
      status: "partial" as const,
      results: [
        { typeId: "deposit", status: "success" as const },
        { typeId: "loan", status: "failed" as const, error: "no account" },
      ],
    };

    assert.deepEqual(
      await finalizeAutomationTaskRun(execution, result({ statementSummary: summary }), ledgerDir),
      { status: "partial" },
    );
    const persisted = taskRunById(db, run.taskRunId)!;
    assert.equal(persisted.status, "partial");
    assert.equal(persisted.errorMessage, null);
    assert.ok(readFileSync(persisted.logPath, "utf8").includes(statementRunSummaryLine(summary.results)));
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("waiting for human remains active until a later run takes over", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-waiting-"));
  try {
    const { db, run, execution } = createExecution(ledgerDir);
    assert.deepEqual(
      await finalizeAutomationTaskRun(
        execution,
        result({ logTail: "Workflow paused. resume --session ses-waiting" }),
        ledgerDir,
      ),
      { status: "waiting_for_human" },
    );
    assert.deepEqual(
      await finalizeAutomationTaskRun(execution, result(), ledgerDir),
      { status: "waiting_for_human" },
    );
    assert.equal(taskRunById(db, run.taskRunId)?.status, "waiting_for_human");
    assert.deepEqual(activeTaskRuns(db).map((active) => active.taskRunId), [run.taskRunId]);
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("persisted finalization preserves the primary error and is idempotent", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-recovery-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const task = taskById("exchange-rates")!;
    const logPath = join(ledgerDir, "recovery.log");
    const run = createTaskRun(db, {
      taskId: task.id,
      script: "run:exchange-rates",
      kind: task.kind,
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath,
      errorMessage: "workflow failed",
    });
    await finalizePersistedRun(db, taskRunById(db, run.taskRunId)!, "App abnormal exit");
    await finalizePersistedRun(db, taskRunById(db, run.taskRunId)!, "different reason");
    const persisted = taskRunById(db, run.taskRunId)!;

    assert.equal(persisted.status, "failed");
    assert.equal(
      persisted.errorMessage,
      "workflow failed\nSession cleanup failed: Missing Libretto session identity",
    );
    assert.equal(readFileSync(logPath, "utf8").split("automation-session-finalize:").length, 2);
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
