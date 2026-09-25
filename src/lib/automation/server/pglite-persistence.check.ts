import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  automationRunHistory,
} from "./desktop-api.ts";
import {
  hydrateAutomationRuntimeState,
  persistCancellationTransitionForRunWithPersistence,
  recoverAbandonedAutomationSessions,
  runAutomationTask,
  startAutomationTask,
} from "./runner.ts";
import { finalizePersistedActiveRuns, finalizeTaskRunTransition } from "./task-run-finalization.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { exchangeRateRequestFromOverview } from "../../../ledger/exchange-rate-requirements.ts";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import {
  humanAssistanceContractForTask,
  humanSessionForTask,
  updateHumanAssistanceCompletionForTask,
  updateHumanAssistanceContractForTask,
} from "./human-session.ts";

const database = await PGlite.create();
const store = new PGliteStore(database);
try {
  await applyPgliteOperationalBaseline(store);
  assert.deepEqual(
    exchangeRateRequestFromOverview({ dailyHistory: [] }),
    { requiredFrom: null, currencies: [] },
    "an empty canonical overview retains the existing no-op exchange request",
  );
  assert.deepEqual(
    exchangeRateRequestFromOverview({
      dailyHistory: [{
        date: "2026-01-03",
        netAssets: [{ currency: "USD", value: 1 }],
        dailyChange: [{ currency: "JPY", value: 1 }],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 0,
      }, {
        date: "2026-01-01",
        netAssets: [{ currency: "TWD", value: 1 }],
        dailyChange: [],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 0,
      }],
    }),
    { requiredFrom: "2026-01-01", currencies: ["JPY", "USD"] },
    "a populated canonical overview derives earliest history and non-TWD currencies",
  );
  const provider = {
    ...createPgliteOperationalProvider(store),
  pgliteWorkflow: {
      required: true,
      env: {
        [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "pglite-persistence-check-token",
    },
  },
  exchangeRates: {
    async readExchangeRates() { return []; },
    async upsertExchangeRates() {},
  },
  financial: {
    async overviewCurrent() { return { dailyHistory: [] }; },
  },
};
  const run = await provider.automation.createTaskRun({
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:00:00.000Z",
    logPath: "data/automation/logs/pglite-human.log",
    logTail: "libretto resume --session pglite-human",
  });

  assert.equal(await humanSessionForTask("exchange-rates", provider), "pglite-human");
  assert.equal(await humanAssistanceContractForTask("exchange-rates", provider), null);
  const contractInput = {
    stageId: "otp",
    title: "Enter OTP",
    targets: [{ id: "otp", label: "OTP", semanticId: "otp", modes: ["type"] as const }],
    contextRegions: [],
    completion: { mode: "inline" as const, targetIds: ["otp"] },
    focus: { targetId: "otp", contextRegionIds: [] },
  };
  const contract = await updateHumanAssistanceContractForTask(
    "exchange-rates",
    contractInput,
    provider,
  );
  assert.equal(contract.version, 1);
  assert.equal(
    (await humanAssistanceContractForTask("exchange-rates", provider))?.stageId,
    "otp",
  );
  assert.equal(
    (await updateHumanAssistanceCompletionForTask("exchange-rates", "entered", provider))
      .completion.status,
    "entered",
  );

  const hydrated = await hydrateAutomationRuntimeState(provider);
  assert.equal(hydrated.tasks.find((task) => task.taskId === "exchange-rates")?.runId, run.taskRunId);
  assert.equal((await automationRunHistory(provider))[0]?.taskRunId, run.taskRunId);

  const cancelling = await persistCancellationTransitionForRunWithPersistence(
    provider,
    run.taskRunId,
    "cancelling",
  );
  assert.equal(cancelling?.status, "cancelling");
  const cancelled = await finalizeTaskRunTransition(
    provider,
    { taskRunId: run.taskRunId, logPath: "data/automation/logs/pglite-human.log" },
    {
      status: "cancelled",
      exitCode: null,
      signal: null,
      errorMessage: null,
      logTail: "cancelled",
    },
  );
  assert.deepEqual(cancelled, { status: "cancelled", skipped: false });

  const abandoned = await provider.automation.createTaskRun({
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:00:00.000Z",
    logPath: "data/automation/logs/pglite-abandoned.log",
    logTail: "libretto resume --session abandoned",
  });
  await recoverAbandonedAutomationSessions(provider);
  assert.equal((await provider.automation.taskRunById(abandoned.taskRunId))?.status, "interrupted");

  const closing = await provider.automation.createTaskRun({
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:00:00.000Z",
    logPath: "data/automation/logs/pglite-closing.log",
  });
  await provider.automation.appendRunEvent({
    runId: closing.taskRunId,
    stage: "collection",
    code: "source-started",
    occurredAt: "2026-09-22T00:00:00.000Z",
  });
  await provider.automation.appendRunEvent({
    runId: closing.taskRunId,
    stage: "validation",
    code: "source-complete",
    occurredAt: "2026-09-25T00:00:00.000Z",
    completed: 2,
    total: 2,
  });
  assert.equal((await provider.automation.taskRunById(closing.taskRunId))?.events.length, 2);
  assert.equal(await provider.automation.pruneRunEvents("2026-09-24T00:00:00.000Z"), 1);
  assert.equal((await provider.automation.taskRunById(closing.taskRunId))?.events[0]?.code, "source-complete");
  await finalizePersistedActiveRuns(provider, "App closed");
  assert.equal((await provider.automation.taskRunById(closing.taskRunId))?.status, "interrupted");

  let exchangeSyncCalled = 0;
  const exchangeExecution = async (
    task: Parameters<typeof runAutomationTaskExecution>[0],
    persistence: Parameters<typeof runAutomationTaskExecution>[1],
    options: Parameters<typeof runAutomationTaskExecution>[2],
    onRunCreated: Parameters<typeof runAutomationTaskExecution>[3],
  ) => runAutomationTaskExecution(
    task,
    persistence,
    {
      ...options,
      runExchangeRateSync: async () => { exchangeSyncCalled += 1; },
    },
    onRunCreated,
  );
  const exchangeExecutionResult = await runAutomationTask("exchange-rates", provider, {
    runExecution: exchangeExecution,
  });
  assert.equal(exchangeExecutionResult.status, "completed");
  assert.equal(exchangeSyncCalled, 1, "PGlite exchange sync must stay in the injected worker path");
  assert.deepEqual(
    (await provider.automation.latestTaskRuns())["exchange-rates"]?.events.map((event) => event.code),
    ["run-started", "run-completed"],
  );

  // Exercise the actual runner command boundary with a deterministic child
  // seam. The runner owns the campaign/finalization flow; the injected seam
  // only stands in for spawning Libretto so this check never opens SQLite.
  const deterministicExecution = async (
    _task: Parameters<typeof runAutomationTaskExecution>[0],
    persistence: Parameters<typeof runAutomationTaskExecution>[1],
    options: Parameters<typeof runAutomationTaskExecution>[2],
    onRunCreated: Parameters<typeof runAutomationTaskExecution>[3],
  ) => {
    const created = options.taskRunId
      ? await persistence.taskRunById(options.taskRunId)
      : null;
    const taskRun = created ?? await persistence.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "data/automation/logs/pglite-runner.log",
    });
    await onRunCreated(taskRun.taskRunId);
    await options.onRuntimeUpdate?.(taskRun.taskRunId);
    return {
      status: "completed" as const,
      taskRunId: taskRun.taskRunId,
      executionId: "pglite-runner-execution",
      session: null,
      owner: null,
      result: {
        exitCode: 0,
        signal: null,
        error: null,
        logTail: "",
        resumeFailure: null,
        statementSummary: null,
        outputPersistenceWarnings: [],
        externalPrerequisiteIds: [],
      },
    };
  };
  const executionResult = await runAutomationTask("exchange-rates", provider, {
    runExecution: deterministicExecution,
  });
  assert.equal(executionResult.status, "completed");
  assert.equal((await provider.automation.latestTaskRuns())["exchange-rates"]?.status, "completed");

  const started = await startAutomationTask("exchange-rates", provider, {
    runExecution: deterministicExecution,
  });
  assert.equal(started.taskId, "exchange-rates");
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal((await provider.automation.taskRunById(started.runId))?.status, "completed");

  const delayedAutomation = new Proxy(provider.automation, {
    get(target, property) {
      if (property === "taskRunById") {
        return async (taskRunId: string) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return provider.automation.taskRunById(taskRunId);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const delayedProvider: AutomationPersistenceProvider = { ...provider, automation: delayedAutomation };
  const delayedResult = await runAutomationTask("exchange-rates", delayedProvider, {
    runExecution: deterministicExecution,
  });
  assert.equal(delayedResult.status, "completed");

  let rejectedLookups = 0;
  const rejectedAutomation = new Proxy(provider.automation, {
    get(target, property) {
      if (property === "taskRunById") {
        return async (taskRunId: string) => {
          rejectedLookups += 1;
          if (rejectedLookups === 2) throw new Error("deliberate lookup rejection");
          return provider.automation.taskRunById(taskRunId);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rejectedProvider: AutomationPersistenceProvider = { ...provider, automation: rejectedAutomation };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      runAutomationTask("exchange-rates", rejectedProvider, {
        runExecution: deterministicExecution,
      }),
      /deliberate lookup rejection/,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
} finally {
  await store.close();
}
