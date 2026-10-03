import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import { workflowBrowserProfileForTask } from "./app-workflow-registry.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
} from "../../../../electron/pglite-child-rpc-client.ts";
import { finalizeAutomationTaskRun } from "./task-run-finalization.ts";
import type { AppWorkflowWorkerStart, AppWorkflowWorkerInboundFrame } from "./app-workflow-worker-protocol.ts";
import { taskById } from "./tasks.ts";
import { configureHostVerificationActorPolicy } from "../verification-config.ts";

const einvoicePasswordFixtureEnvKey = ["LIBRETTO", "CLOUD", "EINVOICE", "PASSWORD"].join("_");

type WorkerScenario = "human-completion" | "commit-crash" | "commit-cancel" | "validation-failure" | "product-invariant";

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
      if (this.scenario === "product-invariant") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => {
          if (frame.eventId === "worker-start-event") {
            this.emit("message", {
              protocolVersion: 2, kind: "event", eventId: "foreign-collection",
              event: { runId: start.taskRunId, stage: "collection", code: "foreign-currency-collection-started", occurredAt: "2026-10-03T08:17:23.000Z" },
            });
          } else {
            this.emit("message", {
              protocolVersion: 2, kind: "failed", taskRunId: start.taskRunId, errorCode: "workflow-failed",
              summary: { status: "partial", counts: { committedCount: 4, itemCount: 4 }, products: [
                { typeId: "deposit", status: "success", itemCount: 4, committedCount: 4 },
                { typeId: "foreign_currency", status: "failed", itemCount: 6, committedCount: 0, errorCode: "workflow-failed" },
              ] },
            });
            this.emit("exit", 1);
          }
        });
        return;
      }
      if (this.scenario === "human-completion" && frame.eventId === "worker-start-event") {
        setImmediate(() => this.emit("message", {
          protocolVersion: 2,
          kind: "human-assistance-request",
          requestId: "worker-assistance-request",
          contract: assistanceContract,
        }));
      } else if (this.scenario === "validation-failure" && frame.eventId === "worker-start-event") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => {
          this.emit("message", {
            protocolVersion: 2,
            kind: "failed",
            taskRunId: start.taskRunId,
            errorCode: "source-validation-failed",
            diagnostic: {
              chain: [{
                type: "TypeError",
                frames: [{ file: "src/workflows/ctbc-statements.ts", line: 321, column: 9 }],
                message: "private-provider-detail",
              }],
              message: "private-provider-detail",
            },
          });
          this.emit("exit", 1);
        });
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

test("a supervised source-validation failure writes a correlated diagnostic record when opted in", async () => {
  const task = taskById("ctbc-statements");
  assert.ok(task);
  const directory = await mkdtemp(join(tmpdir(), "octopus-workflow-diagnostics-"));
  const diagnosticPath = join(directory, "workflow-failures.jsonl");
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    const result = await runAutomationTaskExecution(task, provider.automation, {
      launchEnv: {
        LIBRETTO_CLOUD_CTBC_USER_ID: "private-user-id",
        LIBRETTO_CLOUD_CTBC_ACCOUNT: "private-account-id",
        LIBRETTO_CLOUD_CTBC_PASSWORD: "private-password",
        [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
        [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
        OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE: diagnosticPath,
        OCTOPUSBEAK_APP_ROOT: process.cwd(),
      },
      workflowBrowserPortFactory: () => ({
        async withPage(run) { return await run({} as never); },
      }),
      appWorkflowBrowserConnectionForRun: (runId) => ({
        endpoint: "http://127.0.0.1:43121",
        targetId: `host-page-${runId}`,
      }),
      appWorkflowWorkerFactory: (_path, options) => new TaskExecutionFakeWorker(
        options.workerData,
        "validation-failure",
        () => true,
      ),
    }, async (id) => { taskRunId = id; });

    assert.equal(result.status, "failed");
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.appWorkflowOutcome?.errorCode, "source-validation-failed");
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    const diagnostic = JSON.parse(diagnosticText.trim()) as Record<string, unknown>;
    assert.equal(diagnostic.workflowId, "ctbc-statements");
    assert.equal(diagnostic.taskRunId, taskRunId);
    assert.equal(diagnostic.errorCode, "source-validation-failed");
    assert.equal(diagnostic.stage, "preparation");
    assert.deepEqual(diagnostic.error, {
      chain: [{
        type: "TypeError",
        frames: [{ file: "src/workflows/ctbc-statements.ts", line: 321, column: 9 }],
      }],
    });
    assert.doesNotMatch(diagnosticText, /private-user-id|private-account-id|private-password|private-provider-detail/u);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

class NonBrowserFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  readonly start: AppWorkflowWorkerStart;
  readonly exchange: boolean;
  constructor(start: AppWorkflowWorkerStart) {
    super();
    this.start = start;
    this.exchange = start.workflowId === "exchange-rates";
    setImmediate(() => {
      this.emit("online");
      this.emit("message", {
        protocolVersion: 2,
        kind: "event",
        eventId: "run-started-id",
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
    if (frame.kind === "event-ack" && frame.eventId === "run-started-id") {
      if (this.exchange) {
        setImmediate(() => this.emit("message", {
          protocolVersion: 2,
          kind: "exchange-rate-progress",
          eventId: "progress-id",
          phaseCode: "complete",
          completed: 3,
          total: 3,
          percent: 100,
        }));
      } else this.complete();
    } else if (frame.kind === "event-ack" && frame.eventId === "progress-id") {
      this.complete();
    } else if (frame.kind === "cancel") {
      setImmediate(() => {
        this.emit("message", { protocolVersion: 2, kind: "cancelled", taskRunId: this.start.taskRunId });
        this.emit("exit", 0);
      });
    }
  }
  private complete() {
    setImmediate(() => {
      this.emit("message", {
        protocolVersion: 2,
        kind: "completed",
        taskRunId: this.start.taskRunId,
        summary: null,
      });
      this.emit("exit", 0);
    });
  }
  terminate() { setImmediate(() => this.emit("exit", 1)); return Promise.resolve(1); }
}

test("exchange-rate and MaiCoin dispatch through supervised workers without a browser", async () => {
  for (const taskId of ["exchange-rates", "sync-maicoin"] as const) {
    const task = taskById(taskId);
    assert.ok(task);
    const database = await PGlite.create();
    const store = new PGliteStore(database);
    try {
      await applyPgliteOperationalBaseline(store);
      const provider = createPgliteOperationalProvider(store);
      let start: AppWorkflowWorkerStart | undefined;
      let taskRunId = "";
      const result = await runAutomationTaskExecution(task, provider.automation, {
        launchEnv: {
          [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "/tmp/worker-test.sock",
          [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
        },
        workflowBrowserPortFactory: () => { throw new Error("Nonbrowser task opened a browser."); },
        appWorkflowWorkerFactory: (_path, options) => {
          start = options.workerData as AppWorkflowWorkerStart;
          return new NonBrowserFakeWorker(start);
        },
      }, async (id) => { taskRunId = id; });
      assert.equal(result.status, "completed");
      assert.ok(start);
      assert.equal(start.workflowId, taskId);
      assert.equal(start.browserConnection, undefined);
      assert.equal(start.pgliteRpc?.endpoint, "/tmp/worker-test.sock");
      const run = await provider.automation.taskRunById(taskRunId);
      assert.equal(run?.status, "completed");
      assert.ok(run?.events.some((event) => event.code === "run-started"));
      if (taskId === "exchange-rates") {
        assert.equal(run?.progress?.phaseCode, "complete");
        assert.equal(run?.progress?.percent, 100);
      }
      assert.equal(run && "logPath" in run, false);
    } finally { await store.close(); }
  }
});

test("browser tasks use the supervised App worker, persist events before ACK, and classify an interrupted commit as unknown", async () => {
  // CTBC exercises the shared supervised Chromium worker and financial events.
  const task = taskById("ctbc-statements");
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
      [["LIBRETTO", "CLOUD", "CTBC", "USER", "ID"].join("_")]: "synthetic-user-id",
      [["LIBRETTO", "CLOUD", "CTBC", "ACCOUNT"].join("_")]: "synthetic-account",
      [["LIBRETTO", "CLOUD", "CTBC", "PASSWORD"].join("_")]: "synthetic-password",
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
      assert.ok(startData.browserConnection);
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

    configureHostVerificationActorPolicy({
      isPackaged: false,
      env: { LIBRETTO_CLOUD_CTBC_VERIFICATION_ACTOR: "human" },
    });
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
    configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
    await store.close();
  }
});

test("E-Invoice uses the supervised Chromium worker and keeps runtime identity through deferred finalization", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  assert.ok(task.workflowId);
  assert.equal(workflowBrowserProfileForTask(task.workflowId), undefined);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const runtimeIdentity = {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: "151.0.0.0",
    } as const;
    const launchEnv = {
      LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
      [einvoicePasswordFixtureEnvKey]: "fixture-password",
      [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
      [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
    };
    let taskRunId = "";
    let workerStart: AppWorkflowWorkerStart | undefined;
    let hostInput: Record<string, unknown> | undefined;
    const deferred = await runAutomationTaskExecution(task, provider.automation, {
      launchEnv,
      deferFinalization: true,
      workflowBrowserPortFactory: (input) => {
        hostInput = input as unknown as Record<string, unknown>;
        return {
          async withPage(run) {
            const callback = hostInput?.onRuntimeIdentity;
            if (typeof callback === "function") callback(runtimeIdentity);
            return await run({} as never);
          },
        };
      },
      appWorkflowBrowserConnectionForRun: (runId) => ({
        endpoint: "http://127.0.0.1:43121",
        targetId: `host-page-${runId}`,
      }),
      appWorkflowWorkerFactory: (_workerPath, options) => {
        workerStart = options.workerData as AppWorkflowWorkerStart;
        return new NonBrowserFakeWorker(workerStart);
      },
    }, async (id) => { taskRunId = id; });

    assert.equal(deferred.status, "completed");
    assert.ok(workerStart, "E-Invoice creates the supervised worker");
    assert.equal(workerStart.workflowId, "einvoice-personal-invoices");
    assert.ok(workerStart.browserConnection, "the worker receives the App browser connection");
    assert.equal(typeof hostInput?.onRuntimeIdentity, "function");
    assert.equal(hostInput?.browserProfile, undefined, "E-Invoice uses the shared default profile");
    assert.equal(taskRunId, workerStart.taskRunId);

    const activeRun = await provider.automation.taskRunById(taskRunId);
    assert.equal(activeRun?.status, "running", "deferred execution leaves the terminal transition to its owner");
    assert.deepEqual(activeRun?.browserRuntime, runtimeIdentity);
    assert.equal(activeRun?.appWorkflowOutcome, null);

    const deferredResult = deferred as typeof deferred & {
      result: Parameters<typeof finalizeAutomationTaskRun>[1];
      taskRunId: string;
    };
    await finalizeAutomationTaskRun({
      provider: { automation: provider.automation },
      taskId: task.id,
      taskKind: task.kind,
      taskRunId: deferredResult.taskRunId,
    }, deferredResult.result);

    const finalRun = await provider.automation.taskRunById(taskRunId);
    assert.equal(finalRun?.status, "completed");
    assert.deepEqual(finalRun?.browserRuntime, runtimeIdentity);
    assert.equal(finalRun?.appWorkflowOutcome?.summary, null);
  } finally {
    await store.close();
  }
});

test("runtime identity remains on a failed run when browser launch fails before a summary exists", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const runtimeIdentity = {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: "151.0.0.0",
    } as const;
    const launchEnv = {
      LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
      [einvoicePasswordFixtureEnvKey]: "fixture-password",
      [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
      [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
    };
    let taskRunId = "";
    const result = await runAutomationTaskExecution(task, provider.automation, {
      launchEnv,
      workflowBrowserPortFactory: (input) => ({
        async withPage() {
          const callback = (input as unknown as { onRuntimeIdentity?: (identity: typeof runtimeIdentity) => void }).onRuntimeIdentity;
          callback?.(runtimeIdentity);
          throw new Error("private browser launch detail");
        },
      }),
      appWorkflowWorkerFactory: () => {
        throw new Error("Browser launch failure must happen before worker startup.");
      },
    }, async (id) => { taskRunId = id; });

    assert.equal(result.status, "failed");
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.status, "failed");
    assert.deepEqual(run?.browserRuntime, runtimeIdentity);
    assert.equal(run?.appWorkflowOutcome?.summary, null);
    assert.doesNotMatch(run?.recordJson ?? "", /private browser launch detail|fixture-phone|fixture-password/u);
  } finally {
    await store.close();
  }
});

test("unsupported browser profiles produce a sanitized runtime configuration failure", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    const result = await runAutomationTaskExecution(task, provider.automation, {
      launchEnv: {
        LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
        [einvoicePasswordFixtureEnvKey]: "fixture-password",
        [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
        [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
      },
      workflowBrowserPortFactory: () => {
        throw new BrowserRuntimeConfigurationError("unsupported-profile");
      },
      appWorkflowWorkerFactory: () => {
        throw new Error("An unsupported profile must fail before worker startup.");
      },
    }, async (id) => { taskRunId = id; });

    assert.equal(result.status, "failed");
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.appWorkflowOutcome?.errorCode, "browser-runtime-config-failed");
    assert.equal(run?.appWorkflowOutcome?.summary, null);
    assert.equal(run?.browserRuntime, undefined, "no identity is recorded when resolution fails");
    assert.equal(run?.recordJson.includes("unsupported-profile"), false);
  } finally {
    await store.close();
  }
});

test("operational run summaries keep only the allow-listed Browser Runtime identity fields", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "einvoice-personal-invoices",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    await provider.automation.updateTaskRun(created.taskRunId, {
      browserRuntime: {
        profileId: "default",
        profileRevision: 1,
        chromiumVersion: "151.0.0.0",
        userAgent: "private-user-agent",
        launchArgs: ["private-flag"],
      } as never,
    });

    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.deepEqual(saved?.browserRuntime, {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: "151.0.0.0",
    });
    assert.doesNotMatch(saved?.recordJson ?? "", /private-user-agent|private-flag|launchArgs/u);
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


test("supervised product invariant failures retain the worker code instead of guessing from collection events", async () => {
  const task = taskById("ctbc-statements");
  assert.ok(task);
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    let taskRunId = "";
    await runAutomationTaskExecution(task, provider.automation, {
      launchEnv: {
        LIBRETTO_CLOUD_CTBC_USER_ID: "synthetic-user",
        LIBRETTO_CLOUD_CTBC_ACCOUNT: "synthetic-account",
        LIBRETTO_CLOUD_CTBC_PASSWORD: "synthetic-password",
        [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
        [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
      },
      workflowBrowserPortFactory: () => ({ async withPage(run) { return await run({} as never); } }),
      appWorkflowBrowserConnectionForRun: (id) => ({ endpoint: "http://127.0.0.1:43121", targetId: `host-page-${id}` }),
      appWorkflowWorkerFactory: (_path, options) => new TaskExecutionFakeWorker(options.workerData, "product-invariant", () => true),
    }, async (id) => { taskRunId = id; });
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.appWorkflowOutcome?.errorCode, "workflow-failed");
    assert.equal(run?.appWorkflowOutcome?.summary?.counts.committedCount, 4);
    assert.equal(run?.status, "failed", "a fatal invariant remains a failure with retained receipts");
  } finally {
    await store.close();
  }
});
