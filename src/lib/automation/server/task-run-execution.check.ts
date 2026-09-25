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
  automationTaskChild,
  createAutomationProgressFrameParser,
  interruptActiveAppWorkflows,
  runAutomationTaskExecution,
  terminateAutomationTaskProcessTree,
} from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";

test("progress frames preserve UTF-8 params split across byte chunks", () => {
  const events: unknown[] = [];
  const parser = createAutomationProgressFrameParser((event) => events.push(event));
  const frame = Buffer.from(JSON.stringify({
    type: "progress",
    phaseCode: "collection",
    completed: 1,
    total: 1,
    percent: 100,
    params: { source: "元大銀行" },
  }) + "\n");
  const split = frame.indexOf(Buffer.from("元")) + 1;
  parser.push(frame.subarray(0, split));
  parser.push(frame.subarray(split));
  parser.flush();
  assert.equal((events[0] as { params: { source: string } }).params.source, "元大銀行");
});

test("command-only tasks are rejected before persistence or execution", async () => {
  const baseTask = taskById("exchange-rates");
  assert.ok(baseTask);
  const task = {
    ...baseTask,
    id: "legacy-command-task",
    script: "run:legacy-command-task",
    command: ["node", "-e", "process.exit(42)"],
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

test("Libretto session resumes are rejected by the App executor before persistence", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
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
      { resumeSession: "legacy-session" },
      async () => {},
    ),
    /Libretto session resume is not supported/,
  );
  assert.equal(persistenceCalls, 0);
  assert.equal(automationTaskChild(task.id), undefined);
});

test("exchange-rate dispatch remains typed and stores no output-file path", async () => {
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
    assert.equal(run?.logPath, "");
    assert.equal(run?.logTail, "");
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

test("forced termination aborts exchange-rate sync before returning", async () => {
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
    await terminateAutomationTaskProcessTree(task.id);
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

test("task execution module keeps only runner compatibility types, not process or file-log execution", async () => {
  const source = await readFile(new URL("./task-run-execution.ts", import.meta.url), "utf8");
  assert.match(source, /import type \{ ChildProcess \} from "node:child_process"/);
  assert.doesNotMatch(source, /import\s+\{[^}]*\b(?:spawn|spawnSync)\b[^}]*\}\s+from\s+"node:child_process"/);
  assert.doesNotMatch(source, /\bspawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(source, /\bexecuteAutomationTaskProcess\b/);
  assert.doesNotMatch(source, /\bresolveTaskCommand\b/);
  assert.doesNotMatch(source, /\bappendLog\s*\(/);
  assert.doesNotMatch(source, /\breadFileSync\s*\(/);
  assert.doesNotMatch(source, /\bmkdirSync\s*\(/);
  assert.doesNotMatch(source, /\brmSync\s*\(/);
});
