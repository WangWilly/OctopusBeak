import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  automationRunHistory,
} from "./desktop-api.ts";
import {
  createAutomationRunner,
  hydrateAutomationRuntimeState,
} from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { finalizeOrphanedRuns } from "./active-task-run.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { openTaskRunForCheck } from "./task-run-check-support.ts";
import { exchangeRateRequestFromOverview } from "../../../ledger/exchange-rate-requirements.ts";
import type { AppWorkflowWorkerHandle } from "./app-workflow-worker-supervisor.ts";
import type { AppWorkflowWorkerInboundFrame, AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

class ExchangeRateWorkerFixture extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  readonly start: AppWorkflowWorkerStart;
  constructor(start: AppWorkflowWorkerStart) {
    super();
    this.start = start;
    setImmediate(() => {
      this.emit("online");
      this.emit("message", {
        protocolVersion: 2,
        kind: "event",
        eventId: "pglite-exchange-start",
        event: {
          runId: start.taskRunId,
          stage: "preparation",
          code: "run-started",
          occurredAt: "2026-09-26T00:00:00.000Z",
        },
      });
    });
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    if (frame.kind === "event-ack" && frame.eventId === "pglite-exchange-start") {
      setImmediate(() => {
        this.emit("message", {
          protocolVersion: 2,
          kind: "event",
          eventId: "pglite-exchange-complete",
          event: {
            runId: this.start.taskRunId,
            stage: "finalization",
            code: "run-completed",
            occurredAt: "2026-09-26T00:00:01.000Z",
          },
        });
      });
    } else if (frame.kind === "event-ack" && frame.eventId === "pglite-exchange-complete") {
      setImmediate(() => {
        this.emit("message", { protocolVersion: 2, kind: "completed", taskRunId: this.start.taskRunId, summary: null });
        this.emit("exit", 0);
      });
    }
  }
  terminate() { setImmediate(() => this.emit("exit", 1)); return Promise.resolve(1); }
}

const database = await createTestPGlite("operational");
const store = new PGliteStore(database);
try {
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
  pgliteWorkflow: { endpoint: "http://127.0.0.1:43121/rpc", token: "p".repeat(32) },
  exchangeRates: {
    async readExchangeRates() { return []; },
    async upsertExchangeRates() {},
  },
  financial: {
    async overviewCurrent() { return { dailyHistory: [] }; },
  },
};
  const run = await provider.automation.createTaskRun({
    taskId: "ctbc-statements",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:00:00.000Z",
  });

  assert.equal((await provider.automation.taskRunById(run.taskRunId))?.humanAssistanceContract, null);
  const contractInput = {
    stageId: "otp",
    title: "Enter OTP",
    targets: [{ id: "otp", label: "OTP", semanticId: "otp", modes: ["type"] as const }],
    contextRegions: [],
    completion: { mode: "inline" as const, targetIds: ["otp"] },
    focus: { targetId: "otp", contextRegionIds: [] },
  };
  const contract = await provider.automation.updateHumanAssistanceContract(
    run.taskRunId,
    contractInput,
  );
  assert.equal(contract.version, 1);
  assert.equal(
    (await provider.automation.taskRunById(run.taskRunId))?.humanAssistanceContract?.stageId,
    "otp",
  );
  assert.equal(
    (await provider.automation.updateHumanAssistanceCompletion(run.taskRunId, "entered"))
      .completion.status,
    "entered",
  );

  const hydrated = await hydrateAutomationRuntimeState(provider, createAutomationRuntimeState());
  assert.equal(hydrated.tasks.find((task) => task.taskId === "ctbc-statements")?.runId, run.taskRunId);
  assert.equal((await automationRunHistory(provider))[0]?.taskRunId, run.taskRunId);

  const active = await openTaskRunForCheck(provider.automation, run.taskRunId);
  await active.requestStop("cancelled");
  assert.equal((await provider.automation.taskRunById(run.taskRunId))?.status, "cancelling");
  const cancelled = await active.finish({ summary: null, failure: null });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.appWorkflowOutcome?.errorCode, "cancelled");

  const abandoned = await provider.automation.createTaskRun({
    taskId: "ctbc-statements",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:00:00.000Z",
  });
  await finalizeOrphanedRuns(provider);
  assert.equal((await provider.automation.taskRunById(abandoned.taskRunId))?.status, "interrupted");

  const closing = await provider.automation.createTaskRun({
    taskId: "ctbc-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:00:00.000Z",
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
  await finalizeOrphanedRuns(provider);
  assert.equal((await provider.automation.taskRunById(closing.taskRunId))?.status, "interrupted");

  let exchangeWorkerStarts = 0;
  const runner = createAutomationRunner({ runtime: createAutomationRuntimeState() });
  const exchangeExecution: typeof runAutomationTaskExecution = (task, activeRun, options) => runAutomationTaskExecution(
    task,
    activeRun,
    {
      ...options,
      appWorkflowWorkerFactory: (_path: string, workerOptions: WorkerOptions) => {
        const start = workerOptions.workerData as AppWorkflowWorkerStart;
        exchangeWorkerStarts += 1;
        assert.equal(start.workflowId, "exchange-rates");
        assert.equal(start.browserConnection, undefined);
        assert.ok(start.pgliteRpc);
        return new ExchangeRateWorkerFixture(start);
      },
    },
  );
  const exchangeExecutionResult = await runner.run("exchange-rates", provider, {
    runExecution: exchangeExecution,
  });
  assert.equal(exchangeExecutionResult.status, "completed");
  assert.equal(exchangeWorkerStarts, 1, "the App runner must dispatch exchange sync through a supervised worker");
  assert.deepEqual(
    (await provider.automation.latestTaskRuns())["exchange-rates"]?.events.map((event) => event.code),
    ["run-started", "run-completed"],
  );

  // Exercise the App runner boundary with a deterministic execution seam.
  const deterministicExecution: typeof runAutomationTaskExecution = async (_task, activeRun) => {
    await activeRun.transition("running");
    return { summary: null, failure: null };
  };
  const executionResult = await runner.run("exchange-rates", provider, {
    runExecution: deterministicExecution,
  });
  assert.equal(executionResult.status, "completed");
  assert.equal((await provider.automation.latestTaskRuns())["exchange-rates"]?.status, "completed");

  const started = await runner.start("exchange-rates", provider, {
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
  const delayedResult = await runner.run("exchange-rates", delayedProvider, {
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
    await runner.run("exchange-rates", rejectedProvider, {
      runExecution: deterministicExecution,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
    assert.equal(runner.hasActive(), false, "a failed finalization still releases the task");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
} finally {
  await store.close();
}
