import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { WorkerOptions } from "node:worker_threads";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type {
  AppWorkflowWorkerHandle,
} from "./app-workflow-worker-supervisor.ts";
import {
  interruptActiveAppWorkflows,
  runAutomationTaskExecution,
  abortActiveAppWorkflowExecutions,
} from "./task-run-execution.ts";
import { resumeAppWorkflowHumanAssistance } from "./app-workflow-human-assistance.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
} from "../../../../electron/pglite-child-rpc-client.ts";
import type { AppWorkflowWorkerStart, AppWorkflowWorkerInboundFrame } from "./app-workflow-worker-protocol.ts";
import { taskById } from "./tasks.ts";

type WorkerScenario = "human-completion" | "commit-crash" | "commit-cancel";

const assistanceContract = {
  stageId: "verification",
  title: "Complete verification",
  targets: [{ id: "answer", label: "Answer", semanticId: "verification-answer", modes: ["type"] }],
  contextRegions: [],
  completion: { mode: "inline", targetIds: ["answer"] },
  focus: { targetId: "answer", contextRegionIds: [] },
} as const;

class TaskExecutionFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  eventAckAfterPersistence = false;
  readonly workerData: WorkerOptions["workerData"];
  private readonly scenario: WorkerScenario;
  private readonly isEventPersisted: () => boolean;
  constructor(
    workerData: WorkerOptions["workerData"],
    scenario: WorkerScenario,
    isEventPersisted: () => boolean,
  ) {
    super();
    this.workerData = workerData;
    this.scenario = scenario;
    this.isEventPersisted = isEventPersisted;
    setImmediate(() => {
      this.emit("online");
      const start = this.workerData as AppWorkflowWorkerStart;
      this.emit("message", {
        protocolVersion: 2,
        kind: "event",
        eventId: "worker-start-event",
        event: {
          runId: start.taskRunId,
          stage: "preparation",
          code: "worker-check-started",
          occurredAt: "2026-09-26T00:00:00.000Z",
        },
      });
    });
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    if (frame.kind === "event-ack") {
      this.eventAckAfterPersistence = this.isEventPersisted();
      if (this.scenario === "human-completion" && frame.eventId === "worker-start-event") {
        setImmediate(() => this.emit("message", {
          protocolVersion: 2,
          kind: "human-assistance-request",
          requestId: "worker-assistance-request",
          contract: assistanceContract,
        }));
      } else if (this.scenario !== "human-completion" && frame.eventId === "worker-commit-started") {
        if (this.scenario === "commit-crash") {
          setImmediate(() => {
            this.emit("error", new Error("untrusted provider detail"));
            this.emit("exit", 1);
          });
        }
      } else if (this.scenario !== "human-completion" && frame.eventId === "worker-start-event") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => this.emit("message", {
          protocolVersion: 2,
          kind: "event",
          eventId: "worker-commit-started",
          event: {
            runId: start.taskRunId,
            stage: "commit",
            code: "canonical-commit-started",
            occurredAt: "2026-09-26T00:00:01.000Z",
          },
        }));
      }
      return;
    }
    if (frame.kind === "human-assistance-response") {
      if (this.scenario === "human-completion") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => {
          this.emit("message", frame.status === "entered"
            ? {
              protocolVersion: 2,
              kind: "completed",
              taskRunId: start.taskRunId,
              summary: { status: "financial-admitted", counts: { invoiceCount: 1 } },
            }
            : {
              protocolVersion: 2,
              kind: "failed",
              taskRunId: start.taskRunId,
              errorCode: "workflow-failed",
            });
          this.emit("exit", 0);
        });
      }
      return;
    }
    if (frame.kind === "cancel" && this.scenario === "commit-cancel") {
      const start = this.workerData as AppWorkflowWorkerStart;
      setImmediate(() => {
        this.emit("message", {
          protocolVersion: 2,
          kind: "cancelled",
          taskRunId: start.taskRunId,
        });
        this.emit("exit", 0);
      });
    }
  }
  terminate() {
    setImmediate(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

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

test("browser tasks use the supervised App worker, persist events before ACK, and classify an interrupted commit as unknown", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const persistedEvents = new Set<string>();
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const appendRunEvent = provider.automation.appendRunEvent.bind(provider.automation);
    provider.automation.appendRunEvent = async (event) => {
      await appendRunEvent(event);
      persistedEvents.add(`${event.runId}:${event.code}`);
    };

    const launchEnv = {
      LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "0900000000",
      [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
      [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
    };

    const runScenario = async (scenario: WorkerScenario) => {
      let taskRunId = "";
      let startData: AppWorkflowWorkerStart | undefined;
      let worker: TaskExecutionFakeWorker | undefined;
      let cancellationRequested = false;
      let resolveWorkerCreated!: () => void;
      const workerCreated = new Promise<void>((resolve) => { resolveWorkerCreated = resolve; });
      const execution = runAutomationTaskExecution(task, provider.automation, {
        launchEnv,
        isCancellationRequested: () => cancellationRequested,
        workflowBrowserPortFactory: () => ({
          async withPage(run) { return await run({} as never); },
        }),
        appWorkflowBrowserConnectionForRun: (runId) => ({
          endpoint: "http://127.0.0.1:43121",
          targetId: `host-page-${runId}`,
        }),
        appWorkflowWorkerFactory: (_workerPath, workerOptions) => {
          startData = workerOptions.workerData as AppWorkflowWorkerStart;
          resolveWorkerCreated();
          worker = new TaskExecutionFakeWorker(
            workerOptions.workerData,
            scenario,
            () => persistedEvents.has(`${startData?.taskRunId}:worker-check-started`),
          );
          return worker;
        },
      }, async (id) => { taskRunId = id; });

      if (!startData) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            workerCreated,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("The supervised worker was not created.")), 30_000);
            }),
          ]);
        } catch (error) {
          cancellationRequested = true;
          await execution;
          throw error;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      assert.ok(startData, "the task creates the supervised worker");
      assert.equal(startData.workflowId, task.workflowId);
      assert.equal(startData.input && typeof startData.input, "object");
      assert.equal(startData.pgliteRpc?.endpoint, launchEnv[PGLITE_CHILD_RPC_ENDPOINT_ENV]);
      assert.equal(startData.pgliteRpc?.token, launchEnv[PGLITE_CHILD_RPC_TOKEN_ENV]);
      assert.match(startData.browserConnection.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.ok(startData.browserConnection.targetId.length > 0);
      assert.equal(taskRunId, startData.taskRunId);

      if (scenario === "human-completion") {
        const waitingDeadline = Date.now() + 10_000;
        while (Date.now() < waitingDeadline) {
          const run = await provider.automation.taskRunById(taskRunId);
          if (run?.status === "waiting_for_human") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "waiting_for_human");
        await provider.automation.updateHumanAssistanceCompletion(taskRunId, "entered");
        assert.equal(await resumeAppWorkflowHumanAssistance(taskRunId, "entered"), true);
      } else if (scenario === "commit-cancel") {
        const commitDeadline = Date.now() + 10_000;
        while (Date.now() < commitDeadline) {
          const run = await provider.automation.taskRunById(taskRunId);
          if (run?.events.some((event) => event.code === "canonical-commit-started")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          (await provider.automation.taskRunById(taskRunId))?.events.some((event) => event.code === "canonical-commit-started"),
          true,
        );
        cancellationRequested = true;
      }

      const result = await execution;
      assert.equal(worker?.eventAckAfterPersistence, true);
      return { result, taskRunId, run: await provider.automation.taskRunById(taskRunId) };
    };

    const completed = await runScenario("human-completion");
    assert.equal(completed.result.status, "completed");
    assert.equal(completed.run?.status, "completed");
    assert.ok(completed.run?.events.some((event) => event.code === "worker-check-started"));

    const crashed = await runScenario("commit-crash");
    assert.equal(crashed.result.status, "failed");
    assert.equal(crashed.run?.status, "failed");
    assert.equal(crashed.run?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
    assert.equal(crashed.run?.signal, null, "an ambiguous commit must not be finalized as cancellation");

    const cancelled = await runScenario("commit-cancel");
    assert.equal(cancelled.result.status, "failed");
    assert.equal(cancelled.run?.status, "failed");
    assert.equal(cancelled.run?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
    assert.equal(cancelled.run?.signal, null, "cancelling during commit preserves the unknown outcome");
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
