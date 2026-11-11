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
import type { runAutomationTaskExecution } from "./task-run-execution.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { writeAutomationSettingsFile } from "./config-files.ts";
import { SourceDeviceBusyError, sourceDeviceLocks } from "./source-device-lock.ts";
import { runnerHostForCheck } from "./task-run-check-support.ts";

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

const freshRunner = (
  provider: AutomationPersistenceProvider = providerStub(),
  options: { directory?: string; runExecution?: typeof runAutomationTaskExecution } = {},
) => createAutomationRunner({
  runtime: createAutomationRuntimeState(),
  provider,
  runExecution: options.runExecution,
  ...runnerHostForCheck(options.directory),
});

const exchangeRates = () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  return task;
};

test("typed workflow runtime uses the authenticated PGlite capability", () => {
  const provider = providerStub({});
  assert.deepEqual(resolveTaskRunPlan(exchangeRates(), { pgliteRpc: provider.pgliteWorkflow, ...runnerHostForCheck(), launchEnv: {}, launchVerificationSettings: {} }).pgliteRpc, {
    endpoint: "http://127.0.0.1:43121/rpc",
    token: "test-token",
  });
});

test("typed workflow runtime fails closed when its PGlite capability is absent", () => {
  assert.throws(
    () => resolveTaskRunPlan(exchangeRates(), { pgliteRpc: undefined, ...runnerHostForCheck(), launchEnv: {}, launchVerificationSettings: {} }),
    /PGlite workflow transport is unavailable/u,
  );
  assert.throws(
    () => resolveTaskRunPlan(exchangeRates(), {
      pgliteRpc: { endpoint: "http://127.0.0.1:43121/rpc", token: " " },
      ...runnerHostForCheck(),
      launchEnv: {},
      launchVerificationSettings: {},
    }),
    /PGlite workflow transport is unavailable/u,
  );
});

test("the runner hands the PGlite capability to the execution as a typed value, not process environment", async () => {
  const provider = providerStub();
  const finished = deferred<AutomationTaskRun>();
  let plan: TaskRunPlan | undefined;
  const runExecution: typeof runAutomationTaskExecution = async (executionPlan) => {
    plan = executionPlan;
    return { summary: null, failure: null };
  };
  await freshRunner(provider, { runExecution }).start("exchange-rates", { onSettled: (_taskId, run) => run && finished.resolve(run) });
  await finished.promise;
  assert.deepEqual(plan?.pgliteRpc, provider.pgliteWorkflow);
  assert.equal(
    Object.keys(plan?.launchEnv ?? {}).some((key) => key.startsWith("OCTOPUSBEAK_PGLITE_")),
    false,
  );
});

test("Fubon cannot start with missing or unknown statement selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-runner-selection-"));
  try {
    writeAutomationSettingsFile(join(root, "settings.json"), {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
    });
    await assert.rejects(
      freshRunner(providerStub(), { directory: root }).start("fubon-all-statements"),
      /Select at least one Fubon statement type/u,
    );

    writeAutomationSettingsFile(join(root, "settings.json"), {
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
      LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit,unknown",
    });
    await assert.rejects(
      freshRunner(providerStub(), { directory: root }).start("fubon-all-statements"),
      /Unknown Fubon statement type: unknown/u,
    );
  } finally {
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
    const lock = sourceDeviceLocks[source];
    const runner = freshRunner(providerStub(), { directory: root });
    try {
      writeAutomationSettingsFile(join(root, "settings.json"), settings);
      assert.equal(lock.claim("registration"), null);
      await assert.rejects(
        runner.start(taskId),
        (error: unknown) =>
          error instanceof SourceDeviceBusyError && error.source === source && error.holder === "registration",
      );
      assert.equal(runner.hasActive(), false);
      assert.equal(lock.holder(), "registration", "the refused run leaves the registration holding the device");
    } finally {
      lock.release("registration");
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
  const { automation } = memoryAutomation();
  const finished = deferred<AutomationTaskRun>();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    await run.transition("running");
    await run.recordCommitAttempt({ phase: "started", attemptId: "lost-attempt", product: null, total: 1 });
    throw new Error("worker host crashed mid-commit");
  };
  await freshRunner(providerStub(automation), { runExecution }).start("exchange-rates", {
    onSettled: (_taskId, run) => run && finished.resolve(run),
  });
  const run = await finished.promise;
  assert.equal(run.status, "failed");
  assert.equal(run.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
});

test("cancellation reaches the typed execution through the run's signal and ends the run cancelled", async () => {
  const { runs, automation } = memoryAutomation();
  const started = deferred();
  const finished = deferred<AutomationTaskRun>();
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    started.resolve();
    await aborted(run.signal);
    throw new Error("typed workflow observed cancellation");
  };
  const runner = freshRunner(providerStub(automation), { runExecution });
  const { runId } = await runner.start("exchange-rates", {
    onSettled: (_taskId, run) => run && finished.resolve(run),
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
  const { runs, automation } = memoryAutomation();
  const started = deferred();
  let stopsOnCancel = true;
  const runExecution: typeof runAutomationTaskExecution = async (_plan, run) => {
    if (!stopsOnCancel) return { summary: null, failure: null };
    started.resolve();
    await aborted(run.signal);
    return { summary: null, failure: { code: "cancelled", proven: true } };
  };
  const runner = freshRunner(providerStub(automation), { runExecution });
  const { runId } = await runner.start("exchange-rates");
  await started.promise;

  const statusWhenWorkRan = await runner.whileStopped(async () => {
    await assert.rejects(runner.start("exchange-rates"), /paused while local data is being deleted/u);
    return { status: runs.get(runId)?.status, active: runner.hasActive() };
  });
  assert.deepEqual(statusWhenWorkRan, { status: "cancelled", active: false });

  stopsOnCancel = false;
  const next = await runner.start("exchange-rates");
  assert.notEqual(next.runId, runId, "runs start again once the work settles");
});

test("force-quit aborts the run's force signal and settles only after the execution does", async () => {
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
  const runner = freshRunner(providerStub(), { runExecution });
  const { runId } = await runner.start("exchange-rates", {
    onSettled: (_taskId, run) => run && finished.resolve(run),
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
  const runner = freshRunner(provider, { runExecution });
  const firstFinished = deferred<AutomationTaskRun>();
  const first = await runner.start("exchange-rates", { onSettled: (_taskId, run) => run && firstFinished.resolve(run) });
  while (executions.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const cancellation = runner.cancel("exchange-rates", first.runId);
  await gateReached.promise;
  gate.resolve();
  await cancellation;
  assert.equal((await firstFinished.promise).status, "cancelled");

  const second = await runner.start("exchange-rates");
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
  await freshRunner().shutdown({
    finalizePersistedRuns: async () => { calls.push("finalized"); },
  });
  assert.deepEqual(calls, ["finalized"]);
});

test("runner source has no Libretto command, patch, or session-resume path", async () => {
  const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|resolvePatchCommand|prepareLibrettoRunCdpPatch|automationTaskChild|terminateAutomationTaskProcessTree|relinquishAutomationSessionForTask|finalizeAllOwnedAutomationSessions|resumeSession|resumeFailureMessage|task\.script|task\.command|logPath|logTail|errorMessage/u);
  assert.doesNotMatch(source, /runExchangeRateSyncCommand|exchange-rate-cli-worker|LEDGER_DIR|data\/ledger/u);
});

test("a run whose record cannot be finalized still settles, and a second start adopts the first", async () => {
  const provider = providerStub(memoryAutomation({
    async transitionTaskRunToTerminal() { throw new Error("disk full"); },
  }).automation);
  const release = deferred();
  const runExecution: typeof runAutomationTaskExecution = async () => {
    await release.promise;
    return { summary: null, failure: null };
  };
  const runner = freshRunner(provider, { runExecution });
  const settled = deferred<[string, AutomationTaskRun | null]>();
  const first = await runner.start("exchange-rates", {
    onSettled: (taskId, run) => settled.resolve([taskId, run]),
  });
  assert.equal(first.adopted, undefined);
  const second = await runner.start("exchange-rates");
  assert.equal(second.adopted, true);
  assert.equal(second.runId, first.runId);
  release.resolve();
  assert.deepEqual(await settled.promise, ["exchange-rates", null]);
});
