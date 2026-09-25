import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore } from "../../shared-shell/data-version.ts";
import {
  finalizeAutomationTaskRun,
  finalizePersistedActiveRuns,
  finalizeTaskRunTransition,
  type AutomationTaskProcessResult,
} from "./task-run-finalization.ts";

function result(overrides: Partial<AutomationTaskProcessResult> = {}): AutomationTaskProcessResult {
  return {
    exitCode: 0,
    signal: null,
    error: null,
    logTail: "workflow finished",
    resumeFailure: null,
    statementSummary: null,
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
    ...overrides,
  };
}

test("provider partial status invalidates once without retaining log output", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "/tmp/automation-finalization.log",
    });
    const invalidations = createDataVersionStore();
    const summary = {
      status: "partial" as const,
      results: [
        { typeId: "deposit", status: "success" as const },
        { typeId: "loan", status: "failed" as const, error: "missing account" },
      ],
    };
    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "fubon-all-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
      logPath: "/tmp/automation-finalization.log",
      dataVersionStore: invalidations,
    }, result({ statementSummary: summary })), { status: "partial" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.status, "partial");
    assert.equal(saved?.logTail, "");
    assert.equal(invalidations.snapshot().version, 1);
  } finally {
    await store.close();
  }
});

test("typed App outcome is retained in run metadata without using log tail", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "ctbc-statements",
      script: "workflow:ctbc-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "",
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
      logPath: "",
    }, result({
      logTail: "",
      appWorkflowOutcome: {
        errorCode: null,
        summary: {
          status: "financial-admitted",
          counts: { accountCount: 2, rowCount: 18, itemCount: 12 },
        },
      },
    })), { status: "completed" });

    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.logTail, "");
    assert.deepEqual(saved?.appWorkflowOutcome, {
      errorCode: null,
      summary: {
        status: "financial-admitted",
        counts: { accountCount: 2, rowCount: 18, itemCount: 12 },
      },
    });
    assert.ok(saved?.recordJson.includes('"appWorkflowOutcome"'));
  } finally {
    await store.close();
  }
});

test("typed failure persists only its stable error code and aggregate summary", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "ctbc-statements",
      script: "workflow:ctbc-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "",
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
      logPath: "",
    }, result({
      exitCode: 0,
      logTail: "private account detail 123456789",
      outputPersistenceWarnings: ["private output path /Users/person/statement.csv"],
      appWorkflowOutcome: {
        errorCode: "source-integrity-failed",
        summary: { status: "failed", counts: { rowCount: 6 } },
      },
    })), { status: "failed" });

    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.errorMessage, "Workflow failed (source-integrity-failed).");
    assert.equal(saved?.logTail, "");
    assert.deepEqual(saved?.appWorkflowOutcome, {
      errorCode: "source-integrity-failed",
      summary: { status: "failed", counts: { rowCount: 6 } },
    });
    assert.equal(saved?.recordJson.includes("123456789"), false);
    assert.equal(saved?.recordJson.includes("statement.csv"), false);
  } finally {
    await store.close();
  }
});

test("typed cancellation code produces a cancelled terminal run", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "ctbc-statements",
      script: "workflow:ctbc-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "",
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
      logPath: "",
    }, result({
      exitCode: 1,
      appWorkflowOutcome: { errorCode: "cancelled", summary: null },
    })), { status: "cancelled" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.errorMessage, "Workflow cancelled.");
    assert.equal(saved?.logTail, "");
    assert.equal(saved?.appWorkflowOutcome?.errorCode, "cancelled");
  } finally {
    await store.close();
  }
});

test("App-close interruption preserves typed outcome without touching log files", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "typed-finalization-"));
  const logPath = join(temporaryDirectory, "must-not-exist.log");
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "workflow:typed-test",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath,
    });
    await provider.automation.updateTaskRun(created.taskRunId, {
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "completed", counts: { itemCount: 4 } },
      },
    });

    await finalizePersistedActiveRuns(provider, "App closed");
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.status, "interrupted");
    assert.equal(saved?.logTail, "");
    assert.deepEqual(saved?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "completed", counts: { itemCount: 4 } },
    });
    assert.equal(existsSync(logPath), false);
  } finally {
    await store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a completed typed run can leave the human-assistance waiting state", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "ctbc-statements",
      script: "workflow:ctbc-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "",
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
      logPath: "",
    }, result({
      logTail: "manual-otp-required",
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "financial-admitted", counts: { itemCount: 2 } },
      },
    })), { status: "completed" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.status, "completed");
    assert.equal(saved?.logTail, "");
  } finally {
    await store.close();
  }
});

test("terminal provider transition is idempotent under a stale finalizer", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "/tmp/automation-transition.log",
    });
    const first = await finalizeTaskRunTransition(provider, {
      taskRunId: created.taskRunId,
      logPath: "/tmp/automation-transition.log",
    }, {
      status: "completed",
      exitCode: 0,
      signal: null,
      errorMessage: null,
      logTail: "complete",
    });
    const stale = await finalizeTaskRunTransition(provider, {
      taskRunId: created.taskRunId,
      logPath: "/tmp/automation-transition.log",
    }, {
      status: "failed",
      exitCode: 1,
      signal: null,
      errorMessage: "late failure",
      logTail: "late",
    });
    assert.deepEqual(first, { status: "completed", skipped: false });
    assert.deepEqual(stale, { status: "completed", skipped: true });
    assert.equal((await provider.automation.taskRunById(created.taskRunId))?.errorMessage, null);
  } finally {
    await store.close();
  }
});
