import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationRunner } from "./runner.ts";
import { resolveTaskRunPlan, type TaskRunPlan } from "./task-run-plan.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { AUTOMATION_TASKS, taskById } from "./tasks.ts";
import type {
  AutomationPersistencePort,
  AutomationPersistenceProvider,
  AutomationTaskRun,
} from "./store.ts";
import type { ExchangeRatePersistencePort, ExchangeRateRecord } from "../../../ledger/exchange-rates.ts";
import type { runAutomationTaskExecution } from "./task-run-execution.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { createExchangeRateSyncService, type ExchangeRateSyncCapabilities } from "./exchange-rate-sync-service.ts";
import { writeAutomationSettingsFile } from "./config-files.ts";
import { SourceDeviceBusyError, sourceDeviceLocks } from "./source-device-lock.ts";

function memoryAutomation(overrides: Partial<AutomationPersistencePort> = {}) {
  const runs = new Map<string, AutomationTaskRun>();
  let next = 0;
  const automation = {
    async createTaskRun(input: Parameters<AutomationPersistencePort["createTaskRun"]>[0]) {
      next += 1;
      const taskRunId = `runner-check-${next}`;
      runs.set(taskRunId, {
        finishedAt: null,
        events: [],
        recordJson: "{}",
        humanAssistanceContract: null,
        ...input,
        taskRunId,
      } as AutomationTaskRun);
      return { taskRunId };
    },
    async taskRunById(taskRunId: string) {
      const run = runs.get(taskRunId);
      return run ? { ...run } : null;
    },
    async updateTaskRun(taskRunId: string, update: Partial<AutomationTaskRun>) {
      Object.assign(runs.get(taskRunId)!, update);
    },
    async transitionTaskRunToActive(taskRunId: string, update: Partial<AutomationTaskRun>) {
      Object.assign(runs.get(taskRunId)!, update);
      return { status: runs.get(taskRunId)!.status, applied: true };
    },
    async transitionTaskRunToTerminal(taskRunId: string, update: Partial<AutomationTaskRun>) {
      Object.assign(runs.get(taskRunId)!, update);
      return { status: runs.get(taskRunId)!.status, applied: true };
    },
    async resolveTaskPrerequisiteNotices() {},
    async recordCommitAttempt() {},
    async commitAttempts() { return []; },
    ...overrides,
  } as unknown as AutomationPersistencePort;
  return { runs, automation };
}

function providerStub(automation: Record<string, unknown> | AutomationPersistencePort = memoryAutomation().automation) {
  return {
    automation,
    pgliteWorkflow: { endpoint: "http://127.0.0.1:43121/rpc", token: "test-token" },
    exchangeRates: {
      async readExchangeRates() { return []; },
      async upsertExchangeRates() {},
    },
    financial: {
      async overviewCurrent() { return { dailyHistory: [] }; },
    },
  } as unknown as AutomationPersistenceProvider;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const freshRunner = () => createAutomationRunner({ runtime: createAutomationRuntimeState() });

const exchangeRates = () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  return task;
};

test("typed workflow runtime uses the authenticated PGlite capability", () => {
  const provider = providerStub({});
  assert.deepEqual(resolveTaskRunPlan(exchangeRates(), { pgliteRpc: provider.pgliteWorkflow, launchEnv: {}, launchVerificationSettings: {} }).pgliteRpc, {
    endpoint: "http://127.0.0.1:43121/rpc",
    token: "test-token",
  });
});

test("typed workflow runtime fails closed when its PGlite capability is absent", () => {
  assert.throws(
    () => resolveTaskRunPlan(exchangeRates(), { pgliteRpc: undefined, launchEnv: {}, launchVerificationSettings: {} }),
    /PGlite workflow transport is unavailable/u,
  );
  assert.throws(
    () => resolveTaskRunPlan(exchangeRates(), {
      pgliteRpc: { endpoint: "http://127.0.0.1:43121/rpc", token: " " },
      launchEnv: {},
      launchVerificationSettings: {},
    }),
    /PGlite workflow transport is unavailable/u,
  );
});

test("the runner hands the PGlite capability to the execution as a typed value, not process environment", async () => {
  const runner = freshRunner();
  const provider = providerStub();
  const finished = deferred<AutomationTaskRun>();
  let plan: TaskRunPlan | undefined;
  const runExecution: typeof runAutomationTaskExecution = async (executionPlan) => {
    plan = executionPlan;
    return { summary: null, failure: null };
  };
  await runner.start("exchange-rates", provider, { runExecution, onFinished: finished.resolve });
  await finished.promise;
  assert.deepEqual(plan?.pgliteRpc, provider.pgliteWorkflow);
  assert.equal(
    Object.keys(plan?.launchEnv ?? {}).some((key) => key.startsWith("OCTOPUSBEAK_PGLITE_")),
    false,
  );
});

test("Fubon cannot start with missing or unknown statement selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-runner-selection-"));
  const previousDirectory = process.cwd();
  try {
    process.chdir(root);
    writeAutomationSettingsFile("settings.json", {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
    });
    await assert.rejects(
      freshRunner().start("fubon-all-statements", providerStub()),
      /Select at least one Fubon statement type/u,
    );

    writeAutomationSettingsFile("settings.json", {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
      LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit,unknown",
    });
    await assert.rejects(
      freshRunner().start("fubon-all-statements", providerStub()),
      /Unknown Fubon statement type: unknown/u,
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

for (const { source, taskId, settings } of [
  {
    source: "tdcc",
    taskId: "sync-tdcc",
    settings: { LIBRETTO_CLOUD_TDCC_ENABLED: true, LIBRETTO_CLOUD_TDCC_STATEMENT_TYPES: "securities" },
  },
  {
    source: "cathay",
    taskId: "cathay-all-statements",
    settings: { LIBRETTO_CLOUD_CATHAY_ENABLED: true, LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES: "domestic" },
  },
] as const) {
  test(`a ${source} sync cannot start while a Source device registration holds the device`, async () => {
    const root = await mkdtemp(join(tmpdir(), `automation-runner-${source}-lock-`));
    const previousDirectory = process.cwd();
    const lock = sourceDeviceLocks[source];
    const runner = freshRunner();
    try {
      process.chdir(root);
      writeAutomationSettingsFile("settings.json", settings);
      assert.equal(lock.claim("registration"), null);
      await assert.rejects(
        runner.start(taskId, providerStub()),
        (error: unknown) =>
          error instanceof SourceDeviceBusyError && error.source === source && error.holder === "registration",
      );
      assert.equal(runner.hasActive(), false);
      assert.equal(lock.holder(), "registration", "the refused run leaves the registration holding the device");
    } finally {
      lock.release("registration");
      process.chdir(previousDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("exchange-rate service uses injected overview and persistence with progress", async () => {
  const readCurrencies: string[][] = [];
  const writes: ExchangeRateRecord[][] = [];
  const persistence: ExchangeRatePersistencePort = {
    async readExchangeRates(currencies = []) {
      readCurrencies.push([...currencies]);
      return [];
    },
    async upsertExchangeRates(rows) { writes.push(rows.map((row) => ({ ...row }))); },
  };
  let overviewReads = 0;
  const provider = {
    automation: {},
    exchangeRates: persistence,
    financial: {
      async overviewCurrent() {
        overviewReads += 1;
        return {
          dailyHistory: [{
            date: "2026-01-03",
            netAssets: [{ currency: "USD", value: 100 }],
            dailyChange: [],
            assets: [],
            liabilities: [],
            accountChanges: [],
            positionCount: 1,
          }],
        };
      },
    },
  } as unknown as AutomationPersistenceProvider;
  const progress: Array<{ phaseCode: string | null; completed: number | null }> = [];
  let receivedSignal: AbortSignal | undefined;
  const service = createExchangeRateSyncService(provider as unknown as ExchangeRateSyncCapabilities, {
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString());
      assert.equal(url.searchParams.get("from"), "2025-12-27");
      assert.equal(url.searchParams.get("to"), "2026-07-12");
      receivedSignal = init?.signal as AbortSignal;
      return new Response(JSON.stringify([
        { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0.5 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await service({
    signal: new AbortController().signal,
    emitProgress: (event) => progress.push({ phaseCode: event.phaseCode, completed: event.completed }),
  });

  assert.equal(overviewReads, 1);
  assert.deepEqual(readCurrencies, [["USD"]]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.map(({ currency, twdPerUnit }) => ({ currency, twdPerUnit })), [
    { currency: "USD", twdPerUnit: 2 },
  ]);
  assert.equal(receivedSignal?.aborted, false);
  assert.equal(result.written, 1);
  assert.deepEqual(progress, [
    { phaseCode: "load-request", completed: 0 },
    { phaseCode: "sync", completed: 1 },
    { phaseCode: "complete", completed: 3 },
  ]);
});

test("exchange-rate service forwards cancellation to its in-flight request", async () => {
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  let writes = 0;
  const provider = {
    automation: {},
    exchangeRates: {
      async readExchangeRates() { return []; },
      async upsertExchangeRates() { writes += 1; },
    },
    financial: {
      async overviewCurrent() {
        return {
          dailyHistory: [{
            date: "2026-01-03",
            netAssets: [{ currency: "USD", value: 100 }],
            dailyChange: [],
            assets: [],
            liabilities: [],
            accountChanges: [],
            positionCount: 1,
          }],
        };
      },
    },
  } as unknown as AutomationPersistenceProvider;
  const service = createExchangeRateSyncService(provider as unknown as ExchangeRateSyncCapabilities, {
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    fetchImpl: async (_input, init) => {
      markFetchStarted();
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable after abort");
    },
  });
  const controller = new AbortController();
  const running = service({ signal: controller.signal });
  const rejected = assert.rejects(running, /exchange-rate sync cancelled/u);
  await fetchStarted;
  controller.abort(new Error("exchange-rate sync cancelled"));
  await rejected;
  assert.equal(writes, 0);
});

test("the task catalog contains only typed workflows and the two typed nonbrowser jobs", () => {
  const allowedNonbrowserTaskIds = new Set(["exchange-rates", "sync-maicoin"]);
  assert.ok(AUTOMATION_TASKS.length > 0);
  for (const task of AUTOMATION_TASKS) {
    assert.ok(
      task.workflowId || allowedNonbrowserTaskIds.has(task.id),
      `${task.id} must be registered with the App executor`,
    );
  }
});

test("an execution that throws after starting a commit still ends commit outcome unknown", async () => {
  const runner = freshRunner();
  const { automation } = memoryAutomation();
  const finished = deferred<AutomationTaskRun>();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    await run.transition("running");
    await run.recordCommitAttempt({ phase: "started", attemptId: "lost-attempt", product: null, total: 1 });
    throw new Error("worker host crashed mid-commit");
  };
  await runner.start("exchange-rates", providerStub(automation), {
    runExecution,
    onFinished: finished.resolve,
  });
  const run = await finished.promise;
  assert.equal(run.status, "failed");
  assert.equal(run.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
});

test("cancellation reaches the typed execution through the run's signal and ends the run cancelled", async () => {
  const runner = freshRunner();
  const { runs, automation } = memoryAutomation();
  const provider = providerStub(automation);
  const started = deferred();
  const finished = deferred<AutomationTaskRun>();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    started.resolve();
    await aborted(run.signal);
    throw new Error("typed workflow observed cancellation");
  };
  const { runId } = await runner.start("exchange-rates", provider, {
    runExecution,
    onFinished: finished.resolve,
  });
  await started.promise;
  assert.equal(runner.hasActive(), true);
  assert.equal((await runner.current("exchange-rates"))?.runId, runId);
  await assert.rejects(
    runner.cancel("exchange-rates", "a-different-run"),
    /run changed before cancellation/u,
  );
  assert.notEqual(runs.get(runId)?.status, "cancelling", "a refused cancellation leaves the run alone");
  assert.deepEqual(await runner.cancel("exchange-rates", runId), { cancelled: "exchange-rates" });

  const run = await finished.promise;
  assert.equal(run.status, "cancelled", "a workflow that throws after cancellation is still cancelled");
  assert.equal(run.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(run.terminationMode, undefined);
  assert.equal(runner.hasActive(), false);
});

test("work held for a data deletion runs only after every active run is cancelled and terminal", async () => {
  const runner = freshRunner();
  const { runs, automation } = memoryAutomation();
  const provider = providerStub(automation);
  const started = deferred();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    started.resolve();
    await aborted(run.signal);
    return { summary: null, failure: { code: "cancelled", proven: true } };
  };
  const { runId } = await runner.start("exchange-rates", provider, { runExecution });
  await started.promise;

  const statusWhenWorkRan = await runner.whileStopped(async () => {
    await assert.rejects(runner.start("exchange-rates", provider, { runExecution }), /paused while local data is being deleted/u);
    return { status: runs.get(runId)?.status, active: runner.hasActive() };
  });
  assert.deepEqual(statusWhenWorkRan, { status: "cancelled", active: false });

  const next = await runner.start("exchange-rates", provider, { runExecution: async () => ({ summary: null, failure: null }) });
  assert.notEqual(next.runId, runId, "runs start again once the work settles");
});

test("force-quit aborts the run's force signal and settles only after the execution does", async () => {
  const runner = freshRunner();
  const provider = providerStub();
  const started = deferred();
  const forced = deferred();
  const releaseExecution = deferred();
  const finished = deferred<AutomationTaskRun>();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    started.resolve();
    await aborted(run.forceSignal);
    forced.resolve();
    await releaseExecution.promise;
    return { summary: null, failure: { code: "cancelled", proven: true } };
  };
  const { runId } = await runner.start("exchange-rates", provider, {
    runExecution,
    onFinished: finished.resolve,
  });
  await started.promise;
  await assert.rejects(
    runner.forceTerminate("exchange-rates", "a-different-run"),
    /run changed before force termination/u,
  );
  let forceSettled = false;
  const force = runner.forceTerminate("exchange-rates", runId).then(() => { forceSettled = true; });
  await forced.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(forceSettled, false);
  releaseExecution.resolve();
  await force;
  const run = await finished.promise;
  assert.equal(run.status, "cancelled");
  assert.equal(run.terminationMode, "forced");
  assert.equal(runner.hasActive(), false);
});

test("a cancellation still persisting for a finished run never reaches the task's next run", async () => {
  const runner = freshRunner();
  const gate = deferred();
  const gateReached = deferred();
  const base = memoryAutomation();
  let holdCancelling = true;
  const automation = {
    ...base.automation,
    async transitionTaskRunToActive(taskRunId: string, update: Parameters<AutomationPersistencePort["transitionTaskRunToActive"]>[1]) {
      if (update.status === "cancelling" && holdCancelling) {
        holdCancelling = false;
        gateReached.resolve();
        await gate.promise;
      }
      return base.automation.transitionTaskRunToActive(taskRunId, update);
    },
  } as AutomationPersistencePort;
  const provider = providerStub(automation);
  const executions: ActiveAutomationTaskRun[] = [];
  const releaseNext = deferred();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    executions.push(run);
    if (executions.length === 1) await aborted(run.signal);
    else await releaseNext.promise;
    return { summary: null, failure: null };
  };
  const firstFinished = deferred<AutomationTaskRun>();
  const first = await runner.start("exchange-rates", provider, { runExecution, onFinished: firstFinished.resolve });
  while (executions.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const cancellation = runner.cancel("exchange-rates", first.runId);
  await gateReached.promise;
  gate.resolve();
  await cancellation;
  assert.equal((await firstFinished.promise).status, "cancelled");

  const second = await runner.start("exchange-rates", provider, { runExecution });
  while (executions.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(runner.cancel("exchange-rates", first.runId), /run changed before cancellation/u);
  await assert.rejects(runner.forceTerminate("exchange-rates", first.runId), /run changed before force termination/u);
  assert.equal(executions[1]!.signal.aborted, false);
  assert.notEqual(base.runs.get(second.runId)?.status, "cancelling");
  releaseNext.resolve();
  while (runner.hasActive()) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(base.runs.get(second.runId)?.status, "completed");
});

test("shutdown finalizes persisted runs after stopping active App workflows", async () => {
  const calls: string[] = [];
  await freshRunner().shutdown(providerStub(), {
    finalizePersistedRuns: async () => { calls.push("finalized"); },
  });
  assert.deepEqual(calls, ["finalized"]);
});

test("runner source has no Libretto command, patch, or session-resume path", async () => {
  const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|resolvePatchCommand|prepareLibrettoRunCdpPatch|automationTaskChild|terminateAutomationTaskProcessTree|relinquishAutomationSessionForTask|finalizeAllOwnedAutomationSessions|resumeSession|resumeFailureMessage|task\.script|task\.command|logPath|logTail|errorMessage/u);
  assert.doesNotMatch(source, /runExchangeRateSyncCommand|exchange-rate-cli-worker|LEDGER_DIR|data\/ledger/u);
});
