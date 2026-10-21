import assert from "node:assert/strict";
import test from "node:test";
import { hydrateAutomationRuntimeState, recoverInterruptedAutomationRuns } from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore, type DataVersionStore } from "../../shared-shell/data-version.ts";
import type { AutomationPersistenceProvider, AutomationTaskStatus } from "./store.ts";
import {
  decideAutomationTaskRunOutcome,
  finalizeAutomationTaskRun,
  finalizePersistedActiveRuns,
  type TaskRunStop,
} from "./task-run-finalization.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

async function withProvider(check: (provider: AutomationPersistenceProvider) => Promise<void>) {
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    await check(createPgliteOperationalProvider(store));
  } finally {
    await store.close();
  }
}

async function createRun(
  provider: AutomationPersistenceProvider,
  taskId: string,
  status: AutomationTaskStatus = "running",
) {
  const kind = taskId.startsWith("sync-") || taskId === "exchange-rates" ? "sync" : "crawler";
  const { taskRunId } = await provider.automation.createTaskRun({
    taskId, kind, status, attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
  });
  return taskRunId;
}

async function finalize(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  report: TypedWorkflowOutcome,
  options: { stop?: TaskRunStop; dataVersionStore?: DataVersionStore } = {},
) {
  return finalizeAutomationTaskRun(
    provider.automation,
    taskRunId,
    decideAutomationTaskRunOutcome(report, options.stop ?? null),
    { dataVersionStore: options.dataVersionStore ?? createDataVersionStore() },
  );
}

for (const recovery of ["startup", "shutdown"] as const) {
  test(`${recovery} interrupts abandoned queued runs before hydrating the runtime`, () => withProvider(async (provider) => {
    const taskRunId = await createRun(provider, "exchange-rates", "queued");
    if (recovery === "startup") await recoverInterruptedAutomationRuns(provider);
    else await finalizePersistedActiveRuns(provider, "App closed");
    const saved = await provider.automation.taskRunById(taskRunId);
    assert.equal(saved?.status, "interrupted");
    assert.ok(saved?.finishedAt);
    assert.deepEqual(await provider.automation.activeTaskRuns(), []);
    const runtime = await hydrateAutomationRuntimeState(provider, createAutomationRuntimeState());
    assert.equal(runtime.tasks.find((task) => task.taskId === "exchange-rates")?.status, "interrupted");
  }));
}

test("provider partial status invalidates once without retaining log output", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "fubon-all-statements");
  const invalidations = createDataVersionStore();
  const summary = {
    status: "partial" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [
      { typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 },
      { typeId: "loan" as const, status: "failed" as const, itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" as const },
    ],
  };
  const saved = await finalize(provider, taskRunId, { errorCode: null, summary }, { dataVersionStore: invalidations });
  assert.equal(saved.status, "partial");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.equal(invalidations.snapshot().version, 1);
}));

test("a forced cancellation retains product receipts, records force and invalidates fresh data", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "fubon-all-statements");
  const invalidations = createDataVersionStore();
  const summary = {
    status: "completed" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [{ typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 }],
  } as const;
  const saved = await finalize(provider, taskRunId, { errorCode: "cancelled", summary }, {
    stop: "forced",
    dataVersionStore: invalidations,
  });
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.terminationMode, "forced");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: "cancelled", summary });
  assert.equal(invalidations.snapshot().version, 1, "a verified earlier product commit makes data stale after forced stop");
}));

test("TDCC incomplete receipt outcomes finalize partial, with cancellation and unknown-commit precedence", () => withProvider(async (provider) => {
  const summary = {
    status: "partial" as const,
    counts: { committedCount: 1, itemCount: 1, excludedUnknownInstitutionCount: 1 },
    products: [{
      typeId: "settlement" as const,
      status: "success" as const,
      itemCount: 1,
      committedCount: 1,
      collection: {
        status: "incomplete" as const,
        exclusionCounts: { excludedUnknownInstitutionCount: 1 },
      },
    }],
  };
  const scenarios = [
    { errorCode: "source-unavailable" as const, expectedStatus: "partial" as const },
    { errorCode: "cancelled" as const, expectedStatus: "cancelled" as const },
    { errorCode: "commit-outcome-unknown" as const, expectedStatus: "failed" as const },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const taskRunId = await createRun(provider, "sync-tdcc");
    const saved = await finalize(provider, taskRunId, { errorCode: scenario.errorCode, summary });
    assert.equal(saved.status, scenario.expectedStatus, `scenario ${index + 1} persists its agreed terminal status`);
    assert.deepEqual(saved.appWorkflowOutcome, { errorCode: scenario.errorCode, summary });
  }
}));

test("persisted product commit event invalidates freshness when a later worker crash has no summary", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "yuanta-all-statements");
  await provider.automation.appendRunEvent({
    runId: taskRunId,
    stage: "commit",
    code: "deposit-canonical-commit-completed",
    occurredAt: new Date().toISOString(),
    completed: 1,
    total: 1,
  });
  const invalidations = createDataVersionStore();
  const saved = await finalize(provider, taskRunId, { errorCode: "workflow-failed", summary: null }, {
    dataVersionStore: invalidations,
  });
  assert.equal(saved.status, "failed");
  assert.equal(invalidations.snapshot().version, 1, "only a persisted commit-completed event proves earlier progress");
}));

test("a failure without receipts leaves fresh data alone", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "yuanta-all-statements");
  const invalidations = createDataVersionStore();
  await finalize(provider, taskRunId, { errorCode: "workflow-failed", summary: null }, { dataVersionStore: invalidations });
  assert.equal(invalidations.snapshot().version, 0);
}));

test("typed App outcome is retained in run metadata without using log tail", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "ctbc-statements");
  const summary = { status: "financial-admitted" as const, counts: { accountCount: 2, rowCount: 18, itemCount: 12 } };
  const saved = await finalize(provider, taskRunId, { errorCode: null, summary });
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.ok(saved.recordJson.includes('"appWorkflowOutcome"'));
}));

test("typed failure persists its stable error code and aggregate summary", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "ctbc-statements");
  const report = {
    errorCode: "source-integrity-failed" as const,
    summary: { status: "failed" as const, counts: { rowCount: 6 } },
  };
  const saved = await finalize(provider, taskRunId, report);
  assert.equal(saved.status, "failed");
  assert.deepEqual(saved.appWorkflowOutcome, report);
}));

test("typed cancellation code produces a cancelled terminal run", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "ctbc-statements");
  const saved = await finalize(provider, taskRunId, { errorCode: "cancelled", summary: null });
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(saved.terminationMode, undefined);
}));

test("App-close interruption preserves typed outcome without a file-log contract", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "exchange-rates");
  await provider.automation.updateTaskRun(taskRunId, {
    appWorkflowOutcome: {
      errorCode: null,
      summary: { status: "completed", counts: { itemCount: 4 } },
    },
  });
  await finalizePersistedActiveRuns(provider, "App closed");
  const saved = await provider.automation.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.deepEqual(saved?.appWorkflowOutcome, {
    errorCode: null,
    summary: { status: "completed", counts: { itemCount: 4 } },
  });
}));

test("a completed typed run can leave the human-assistance waiting state", () => withProvider(async (provider) => {
  const taskRunId = await createRun(provider, "ctbc-statements", "waiting_for_human");
  const saved = await finalize(provider, taskRunId, {
    errorCode: null,
    summary: { status: "financial-admitted", counts: { itemCount: 2 } },
  });
  assert.equal(saved.status, "completed");
}));

test("competing finalizers persist one decision and apply freshness and notices only once", () => withProvider(async (provider) => {
  const resolveNotices = provider.automation.resolveTaskPrerequisiteNotices.bind(provider.automation);
  let noticesResolved = 0;
  provider.automation.resolveTaskPrerequisiteNotices = async (...args) => {
    noticesResolved += 1;
    return resolveNotices(...args);
  };
  const summary = { status: "completed", counts: { committedCount: 1, itemCount: 1 } } as const;
  for (const status of ["completed", "failed", "cancelled"] as const) {
    noticesResolved = 0;
    const taskRunId = await createRun(provider, "yuanta-trade-statements");
    const invalidations = createDataVersionStore();
    const stop = status === "completed" ? undefined : "forced" as const;
    const errorCode = status === "failed" ? "commit-outcome-unknown" as const : null;
    const winners = await Promise.all([
      finalize(provider, taskRunId, { errorCode, summary }, { stop, dataVersionStore: invalidations }),
      finalize(provider, taskRunId, { errorCode, summary }, { stop, dataVersionStore: invalidations }),
    ]);
    assert.deepEqual(winners.map((run) => run.status), [status, status]);
    const late = await finalize(provider, taskRunId, { errorCode: "source-unavailable", summary: null }, {
      dataVersionStore: invalidations,
    });
    assert.equal(late.status, status, "a later caller with a conflicting decision preserves the winner");
    const saved = await provider.automation.taskRunById(taskRunId);
    assert.equal(saved?.status, status);
    assert.deepEqual(saved?.appWorkflowOutcome, {
      errorCode: status === "cancelled" ? "cancelled" : errorCode,
      summary,
    });
    assert.equal(saved?.terminationMode === "forced", status === "cancelled");
    assert.equal(invalidations.snapshot().version, 1, "durable receipts invalidate once for every terminal status");
    assert.equal(noticesResolved, status === "completed" ? 1 : 0);
  }
}));
