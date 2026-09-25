import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import {
  cancelAutomationTask,
  hasActiveAutomationTask,
  pgliteWorkflowRuntimeEnv,
  prepareLibrettoRunCdpPatch,
  forceTerminateAutomationTask,
  runAutomationTask,
  shutdownAutomationSessions,
} from "./runner.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import type {
  AutomationPersistenceProvider,
  AutomationTaskRun,
} from "./store.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";

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

test("the main-process legacy patch hook is inert", () => {
  assert.equal(prepareLibrettoRunCdpPatch(), undefined);
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
  await shutdownAutomationSessions(provider, {
    finalizePersistedRuns: async (_provider, reason) => { calls.push(reason); },
  });
  assert.deepEqual(calls, ["App 關閉，人工操作未完成"]);
});

test("runner source has no Libretto command, child-process, or session-relinquish path", async () => {
  const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|resolvePatchCommand|automationTaskChild|terminateAutomationTaskProcessTree|relinquishAutomationSessionForTask|finalizeAllOwnedAutomationSessions|resumeSession/u);
});
