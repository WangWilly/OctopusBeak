import assert from "node:assert/strict";
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
  type AutomationTaskExecutionResult,
} from "./task-run-finalization.ts";

function result(overrides: Partial<AutomationTaskExecutionResult> = {}): AutomationTaskExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    error: null,
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
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
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
      dataVersionStore: invalidations,
    }, result({ statementSummary: summary })), { status: "partial" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.status, "partial");
    assert.deepEqual(saved?.appWorkflowOutcome, { errorCode: null, summary: null });
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
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
    }, result({
      appWorkflowOutcome: {
        errorCode: null,
        summary: {
          status: "financial-admitted",
          counts: { accountCount: 2, rowCount: 18, itemCount: 12 },
        },
      },
    })), { status: "completed" });

    const saved = await provider.automation.taskRunById(created.taskRunId);
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
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
    }, result({
      exitCode: 0,
      error: new Error("private account detail 123456789"),
      outputPersistenceWarnings: ["private output path /Users/person/statement.csv"],
      appWorkflowOutcome: {
        errorCode: "source-integrity-failed",
        summary: { status: "failed", counts: { rowCount: 6 } },
      },
    })), { status: "failed" });

    const saved = await provider.automation.taskRunById(created.taskRunId);
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
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
    }, result({
      exitCode: 1,
      appWorkflowOutcome: { errorCode: "cancelled", summary: null },
    })), { status: "cancelled" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.appWorkflowOutcome?.errorCode, "cancelled");
  } finally {
    await store.close();
  }
});

test("App-close interruption preserves typed outcome without a file-log contract", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
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
    assert.deepEqual(saved?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "completed", counts: { itemCount: 4 } },
    });
  } finally {
    await store.close();
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
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(await finalizeAutomationTaskRun({
      provider,
      taskId: "ctbc-statements",
      taskKind: "crawler",
      taskRunId: created.taskRunId,
    }, result({
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "financial-admitted", counts: { itemCount: 2 } },
      },
    })), { status: "completed" });
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(saved?.status, "completed");
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
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const first = await finalizeTaskRunTransition(provider, {
      taskRunId: created.taskRunId,
    }, {
      status: "completed",
      exitCode: 0,
      signal: null,
      appWorkflowOutcome: { errorCode: null, summary: null },
    });
    const stale = await finalizeTaskRunTransition(provider, {
      taskRunId: created.taskRunId,
    }, {
      status: "failed",
      exitCode: 1,
      signal: null,
      appWorkflowOutcome: { errorCode: "workflow-failed", summary: null },
    });
    assert.deepEqual(first, { status: "completed", skipped: false });
    assert.deepEqual(stale, { status: "completed", skipped: true });
    assert.deepEqual(
      (await provider.automation.taskRunById(created.taskRunId))?.appWorkflowOutcome,
      { errorCode: null, summary: null },
    );
  } finally {
    await store.close();
  }
});
