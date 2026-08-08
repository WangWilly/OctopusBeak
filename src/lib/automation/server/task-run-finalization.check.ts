import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { statementRunSummaryLine } from "../statement-run-summary.ts";
import {
  activeTaskRuns,
  activeTaskPrerequisiteNotices,
  allTaskPrerequisiteNotices,
  createTaskRun,
  taskRunById,
  updateTaskRun,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import { liveTaskRunUpdate } from "./task-run-execution.ts";
import {
  finalizeAutomationTaskRun,
  finalizePersistedRun,
  type AutomationTaskProcessResult,
  type AutomationTaskRunFinalizationContext,
} from "./task-run-finalization.ts";

function createExecution(ledgerDir: string, taskId = "exchange-rates") {
  const db = openLedgerDatabase(ledgerDir);
  const task = taskById(taskId)!;
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
  const finalization = {
    taskDb: db,
    taskId: task.id,
    taskKind: task.kind,
    taskRunId: run.taskRunId,
    logPath,
    ledgerDir,
  } satisfies AutomationTaskRunFinalizationContext;
  return { db, run, finalization };
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
    externalPrerequisiteIds: [],
    ...overrides,
  };
}

test("live finalization persists a partial statement outcome through one transition", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-live-"));
  try {
    const { db, run, finalization } = createExecution(ledgerDir);
    const summary = {
      status: "partial" as const,
      results: [
        { typeId: "deposit", status: "success" as const },
        { typeId: "loan", status: "failed" as const, error: "no account" },
      ],
    };

    assert.deepEqual(
      await finalizeAutomationTaskRun(finalization, result({ statementSummary: summary })),
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

test("external prerequisite notices are deduplicated and resolved by a successful rerun", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-prerequisite-"));
  try {
    const first = createExecution(ledgerDir, "yuanta-trade-statements");
    await finalizeAutomationTaskRun(first.finalization, result({
      exitCode: 1,
      error: new Error("certificate component unavailable"),
      externalPrerequisiteIds: ["yuanta-servisign"],
    }));
    assert.equal(activeTaskPrerequisiteNotices(first.db).length, 1);

    const second = createExecution(ledgerDir, "yuanta-trade-statements");
    await finalizeAutomationTaskRun(second.finalization, result({
      exitCode: 1,
      error: new Error("certificate component unavailable"),
      externalPrerequisiteIds: ["yuanta-servisign"],
    }));
    const active = activeTaskPrerequisiteNotices(second.db);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.latestTaskRunId, second.run.taskRunId);
    assert.equal(active[0]?.latestErrorMessage, "certificate component unavailable");
    assert.equal(allTaskPrerequisiteNotices(second.db).length, 1);

    const successful = createExecution(ledgerDir, "yuanta-trade-statements");
    await finalizeAutomationTaskRun(successful.finalization, result());
    assert.deepEqual(activeTaskPrerequisiteNotices(successful.db), []);
    const resolved = allTaskPrerequisiteNotices(successful.db)[0];
    assert.equal(resolved?.resolvedByTaskRunId, successful.run.taskRunId);
    assert.ok(resolved?.resolvedAt);
    first.db.close();
    second.db.close();
    successful.db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("waiting for human remains active until a later run takes over", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-waiting-"));
  try {
    const { db, run, finalization } = createExecution(ledgerDir);
    assert.deepEqual(
      await finalizeAutomationTaskRun(
        finalization,
        result({ logTail: "Workflow paused. resume --session ses-waiting" }),
      ),
      { status: "waiting_for_human" },
    );
    assert.deepEqual(
      await finalizeAutomationTaskRun(finalization, result()),
      { status: "waiting_for_human" },
    );
    assert.equal(taskRunById(db, run.taskRunId)?.status, "waiting_for_human");
    assert.deepEqual(activeTaskRuns(db).map((active) => active.taskRunId), [run.taskRunId]);
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("resume failure remains in flight until task-run finalization completes", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-finalization-resume-failure-"));
  try {
    const { db, run, finalization } = createExecution(ledgerDir);
    const logTail = "Workflow failed after resume: Unexpected end of JSON input";
    updateTaskRun(db, run.taskRunId, liveTaskRunUpdate(logTail));

    assert.deepEqual(
      await finalizeAutomationTaskRun(
        finalization,
        result({
          exitCode: 1,
          logTail,
          resumeFailure: "Unexpected end of JSON input",
        }),
      ),
      { status: "failed" },
    );
    const persisted = taskRunById(db, run.taskRunId)!;
    assert.equal(persisted.status, "failed");
    assert.ok(persisted.finishedAt, "failed run must be finalized after its process exits");
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
