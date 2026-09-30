import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import {
  cancelAutomationTask,
  hasActiveAutomationTask,
  pgliteWorkflowRuntimeEnv,
  forceTerminateAutomationTask,
  runAutomationTask,
  shutdownAppAutomationWorkflows,
} from "./runner.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import type {
  AutomationPersistenceProvider,
  AutomationTaskRun,
} from "./store.ts";
import type { ExchangeRatePersistencePort, ExchangeRateRecord } from "../../../ledger/exchange-rates.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { createExchangeRateSyncService, type ExchangeRateSyncCapabilities } from "./exchange-rate-sync-service.ts";

function providerStub(automation: Record<string, unknown> = {}) {
  return {
    automation: {
      async taskRunById() { return null; },
      ...automation,
    },
    pgliteWorkflow: {
      required: true,
      env: {
        [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "test-token",
      },
    },
    exchangeRates: {
      async readExchangeRates() { return []; },
      async upsertExchangeRates() {},
    },
    financial: {
      async overviewCurrent() { return { dailyHistory: [] }; },
    },
  } as unknown as AutomationPersistenceProvider;
}

test("typed workflow runtime uses the authenticated PGlite capability", () => {
  const provider = providerStub({});
  const provided = (provider as unknown as {
    pgliteWorkflow: { required: boolean; env: NodeJS.ProcessEnv };
  }).pgliteWorkflow.env;
  const launched = pgliteWorkflowRuntimeEnv(provider);
  assert.deepEqual(launched, provided);
  assert.notEqual(launched, provided);
});

test("typed workflow runtime fails closed when its PGlite capability is absent", () => {
  assert.throws(
    () => pgliteWorkflowRuntimeEnv({ automation: {} } as unknown as AutomationPersistenceProvider),
    /PGlite workflow transport is unavailable/u,
  );
  const provider = providerStub({});
  (provider as unknown as { pgliteWorkflow: { required: boolean; env: NodeJS.ProcessEnv } })
    .pgliteWorkflow.required = false;
  assert.throws(() => pgliteWorkflowRuntimeEnv(provider), /PGlite workflow transport is unavailable/u);
});

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

test("runner cancellation aborts the typed execution without accessing a child process", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let cancellationObserved = false;
  const runExecution: typeof runAutomationTaskExecution = async (
    _task,
    _persistence,
    options,
    onRunCreated,
  ) => {
    await onRunCreated("runner-cancellation-check");
    markStarted();
    return await new Promise<Awaited<ReturnType<typeof runAutomationTaskExecution>>>(
      (_resolve, reject) => {
        const poll = setInterval(() => {
          if (!options.isCancellationRequested?.()) return;
          cancellationObserved = true;
          clearInterval(poll);
          reject(new Error("typed workflow observed cancellation"));
        }, 5);
      },
    );
  };
  const provider = providerStub();
  const run = runAutomationTask("exchange-rates", provider, { runExecution });
  const rejectedRun = run.then(
    () => assert.fail("the cancelled runner should propagate the typed execution result"),
    (error: unknown) => error,
  );
  await started;
  assert.equal(hasActiveAutomationTask(), true);
  assert.deepEqual(await cancelAutomationTask("exchange-rates", provider), {
    cancelled: "exchange-rates",
  });
  const error = await rejectedRun;
  assert.match(String(error), /typed workflow observed cancellation/u);
  assert.equal(cancellationObserved, true);
  assert.equal(hasActiveAutomationTask(), false);
});

test("force termination waits for typed cancellation to settle", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markCancellationObserved!: () => void;
  const cancellationObserved = new Promise<void>((resolve) => { markCancellationObserved = resolve; });
  let releaseExecution!: () => void;
  const executionRelease = new Promise<void>((resolve) => { releaseExecution = resolve; });
  let forceRequested = false;
  const runExecution: typeof runAutomationTaskExecution = async (
    _task,
    _persistence,
    options,
    onRunCreated,
  ) => {
    await onRunCreated("runner-force-check");
    markStarted();
    await new Promise<void>((_resolve, reject) => {
      const poll = setInterval(() => {
        if (!options.isCancellationRequested?.()) return;
        forceRequested = options.isForceTerminationRequested?.() === true;
        clearInterval(poll);
        markCancellationObserved();
        void executionRelease.then(() => reject(new Error("typed workflow force-cancelled")));
      }, 5);
    });
    return null as never;
  };
  const provider = providerStub();
  const run = runAutomationTask("exchange-rates", provider, { runExecution });
  const settledRun = run.then(() => undefined, () => undefined);
  await started;
  let forceSettled = false;
  const force = forceTerminateAutomationTask("exchange-rates", provider).then(() => {
    forceSettled = true;
  });
  await cancellationObserved;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(forceRequested, true);
  assert.equal(forceSettled, false);
  releaseExecution();
  await force;
  await settledRun;
  assert.equal(forceSettled, true);
  assert.equal(hasActiveAutomationTask(), false);
});

test("shutdown finalizes persisted runs after aborting active App workflows", async () => {
  const calls: string[] = [];
  const provider = providerStub();
  await shutdownAppAutomationWorkflows(provider, {
    finalizePersistedRuns: async (_provider, reason) => { calls.push(reason); },
  });
  assert.deepEqual(calls, ["App 關閉，人工操作未完成"]);
});

test("runner source has no Libretto command, patch, or session-resume path", async () => {
  const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|resolvePatchCommand|prepareLibrettoRunCdpPatch|automationTaskChild|terminateAutomationTaskProcessTree|relinquishAutomationSessionForTask|finalizeAllOwnedAutomationSessions|resumeSession|resumeFailureMessage|task\.script|task\.command|logPath|logTail|errorMessage/u);
  assert.doesNotMatch(source, /runExchangeRateSyncCommand|exchange-rate-cli-worker|LEDGER_DIR|data\/ledger/u);
});
