import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  interruptActiveAppWorkflows,
  runAutomationTaskExecution,
  abortActiveAppWorkflowExecutions,
} from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";

test("command-only tasks are rejected before persistence or execution", async () => {
  const baseTask = taskById("exchange-rates");
  assert.ok(baseTask);
  const task = {
    ...baseTask,
    id: "legacy-command-task",
    workflowId: undefined,
  };
  let persistenceCalls = 0;
  const persistence = new Proxy({}, {
    get() {
      persistenceCalls += 1;
      return async () => undefined;
    },
  });

  await assert.rejects(
    () => runAutomationTaskExecution(
      task,
      persistence as never,
      {},
      async () => {},
    ),
    /App workflow definition is unavailable/,
  );
  assert.equal(persistenceCalls, 0);
});

test("resuming a missing App run fails closed without invoking a workflow", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  let workflowCalls = 0;
  const persistence = {
    async taskRunById() { return null; },
  };
  const result = await runAutomationTaskExecution(
    task,
    persistence as never,
    { taskRunId: "missing-app-run" },
    async () => { workflowCalls += 1; },
  );
  assert.deepEqual(result, { status: "failed" });
  assert.equal(workflowCalls, 0);
});

test("exchange-rate dispatch remains typed and stores no file metadata", async () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    const result = await runAutomationTaskExecution(
      task,
      provider.automation,
      {
        runExchangeRateSync: async ({ emitProgress }) => {
          emitProgress?.({
            phaseCode: "collection",
            completed: 1,
            total: 1,
            percent: 100,
          });
          return { status: "completed" };
        },
      },
      async (id) => { taskRunId = id; },
    );

    assert.equal(result.status, "completed");
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.status, "completed");
    assert.equal(run && "logPath" in run, false);
    assert.equal(run && "logTail" in run, false);
    assert.equal(run && "script" in run, false);
    assert.ok(run?.events.some((event) => event.code === "progress-update"));
  } finally {
    await store.close();
  }
});

test("normal cancellation aborts exchange-rate sync and finalizes after it settles", async () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    let cancellationRequested = false;
    let syncSettled = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execution = runAutomationTaskExecution(
      task,
      provider.automation,
      {
        isCancellationRequested: () => cancellationRequested,
        runExchangeRateSync: async ({ signal }) => {
          markStarted();
          if (!signal) throw new Error("Exchange-rate sync must receive a signal.");
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => {
              setTimeout(() => {
                syncSettled = true;
                resolve();
              }, 30);
            }, { once: true });
            if (signal.aborted) reject(signal.reason);
          });
          return { status: "completed" };
        },
      },
      async (id) => { taskRunId = id; },
    );

    await started;
    cancellationRequested = true;
    const result = await execution;
    assert.equal(syncSettled, true);
    assert.equal(result.status, "cancelled");
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "cancelled");
  } finally {
    await store.close();
  }
});

test("App shutdown hook aborts active typed exchange-rate work", async () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    let syncSettled = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execution = runAutomationTaskExecution(
      task,
      provider.automation,
      {
        runExchangeRateSync: async ({ signal }) => {
          markStarted();
          if (!signal) throw new Error("Exchange-rate sync must receive a signal.");
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => {
              setTimeout(() => {
                syncSettled = true;
                resolve();
              }, 30);
            }, { once: true });
            if (signal.aborted) reject(signal.reason);
          });
          return { status: "completed" };
        },
      },
      async (id) => { taskRunId = id; },
    );

    await started;
    abortActiveAppWorkflowExecutions();
    const result = await execution;
    assert.equal(syncSettled, true);
    assert.equal(result.status, "cancelled");
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "cancelled");
  } finally {
    await store.close();
  }
});

test("App shutdown waits for exchange-rate sync to settle before interruption", async () => {
  const task = taskById("exchange-rates");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    let syncSettled = false;
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const execution = runAutomationTaskExecution(
      task,
      provider.automation,
      {
        runExchangeRateSync: async ({ signal }) => {
          markStarted();
          if (!signal) throw new Error("Exchange-rate sync must receive a signal.");
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => {
              markAborted();
              setTimeout(() => {
                syncSettled = true;
                resolve();
              }, 30);
            }, { once: true });
            if (signal.aborted) reject(signal.reason);
          });
          return { status: "completed" };
        },
      },
      async (id) => { taskRunId = id; },
    );

    await started;
    const shutdown = interruptActiveAppWorkflows(provider.automation);
    await aborted;
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "running");
    await shutdown;
    const result = await execution;
    assert.equal(syncSettled, true);
    assert.equal(result.status, "interrupted");
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "interrupted");
  } finally {
    await store.close();
  }
});

test("task execution module has no command, session-resume, or file-log path", async () => {
  const source = await readFile(new URL("./task-run-execution.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|ChildProcess|spawnSync|automationTaskChild|terminateAutomationTaskProcessTree/u);
  assert.doesNotMatch(source, /\b(?:resumeSession|resumeFailure|logTail|logPath|script|command)\b/u);
  assert.doesNotMatch(source, /\b(?:executeAutomationTaskProcess|resolveTaskCommand|appendLog)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:readFileSync|mkdirSync|rmSync)\s*\(/u);
});
