import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerOptions } from "node:worker_threads";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type {
  AppWorkflowWorkerHandle,
} from "./app-workflow-worker-supervisor.ts";
import type { ActiveAutomationTaskRun, WorkflowExecution } from "./active-task-run.ts";
import { createAutomationRunner } from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { CHECK_PGLITE_RPC, executeTaskRunForCheck, observingExecutions, openTaskRunForCheck } from "./task-run-check-support.ts";
import { runAutomationTaskExecution, type AutomationTaskExecutionOptions } from "./task-run-execution.ts";
import {
  completeAppWorkflowHumanAssistance,
  type AppWorkflowHumanAssistanceRequest,
} from "./app-workflow-human-assistance.ts";
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import { workflowBrowserProfileForTask } from "./app-workflow-registry.ts";
import type { AppWorkflowWorkerStart, AppWorkflowWorkerInboundFrame } from "./app-workflow-worker-protocol.ts";
import { taskById } from "./tasks.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

async function createRun(
  provider: ReturnType<typeof createPgliteOperationalProvider>,
  task: NonNullable<ReturnType<typeof taskById>>,
) {
  const created = await provider.automation.createTaskRun({
    taskId: task.id,
    kind: task.kind,
    status: "preparing",
    attempt: 1,
    maxAttempts: task.maxAttempts,
    startedAt: new Date().toISOString(),
  });
  return created.taskRunId;
}

const einvoicePasswordFixtureEnvKey = ["LIBRETTO", "CLOUD", "EINVOICE", "PASSWORD"].join("_");

type WorkerScenario =
  | "assistance-completion"
  | "commit-crash"
  | "commit-cancel"
  | "commit-cancel-settled"
  | "validation-failure"
  | "product-invariant";

const assistanceContract = {
  stageId: "verification",
  title: "Complete verification",
  challengeKind: "text-captcha",
  targets: [{ id: "answer", label: "Answer", semanticId: "verification-answer", modes: ["type"] }],
  contextRegions: [],
  completion: { mode: "inline", targetIds: ["answer"] },
  focus: { targetId: "answer", contextRegionIds: [] },
} as const;

/** Builds the host calls a scripted worker makes, naming each so its reply can be recognised. */
class ScriptedHostCalls {
  private readonly names = new Map<string, string>();
  call(name: string, method: string, request: unknown) {
    const callId = randomUUID();
    this.names.set(callId, name);
    return { protocolVersion: 3, kind: "call", callId, method, request } as const;
  }
  /** The name of the call a reply answers, if the frame is one. */
  answered(frame: AppWorkflowWorkerInboundFrame) {
    return frame.kind === "reply" ? this.names.get(frame.callId) : undefined;
  }
}

class TaskExecutionFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  eventAckAfterPersistence = false;
  readonly workerData: WorkerOptions["workerData"];
  private readonly calls = new ScriptedHostCalls();
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
      this.emit("message", this.calls.call("worker-start-event", "event", {
        event: {
          runId: start.taskRunId,
          stage: "preparation",
          outcome: "started", code: "worker-check-started",
          occurredAt: "2026-09-26T00:00:00.000Z",
        },
      }));
    });
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    const answered = this.calls.answered(frame);
    if (answered === "worker-commit-settled") {
      // The settlement crossed a stop; the worker now ends the cancelled run.
      const start = this.workerData as AppWorkflowWorkerStart;
      setImmediate(() => {
        this.emit("message", { protocolVersion: 3, kind: "cancelled", taskRunId: start.taskRunId });
        this.emit("exit", 0);
      });
      return;
    }
    if (frame.kind === "reply" && answered === "worker-assistance-request") {
      if (this.scenario === "assistance-completion") {
        const start = this.workerData as AppWorkflowWorkerStart;
        const status = frame.ok ? (frame.result as { status: string }).status : null;
        setImmediate(() => {
          this.emit("message", status === "entered"
            ? {
              protocolVersion: 3,
              kind: "completed",
              taskRunId: start.taskRunId,
              summary: { status: "financial-admitted", counts: { invoiceCount: 1 } },
            }
            : {
              protocolVersion: 3,
              kind: "failed",
              taskRunId: start.taskRunId,
              errorCode: "workflow-failed",
            });
          this.emit("exit", 0);
        });
      }
      return;
    }
    if (frame.kind === "reply") {
      this.eventAckAfterPersistence = this.isEventPersisted();
      if (this.scenario === "product-invariant") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => {
          if (answered === "worker-start-event") {
            this.emit("message", this.calls.call("foreign-collection", "event", {
              event: { runId: start.taskRunId, stage: "collection", outcome: "started", code: "foreign-currency-collection-started", occurredAt: "2026-10-03T08:17:23.000Z" },
            }));
          } else {
            this.emit("message", {
              protocolVersion: 3, kind: "failed", taskRunId: start.taskRunId, errorCode: "workflow-failed",
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
      if (this.scenario === "assistance-completion" && answered === "worker-start-event") {
        setImmediate(() => this.emit("message", this.calls.call(
          "worker-assistance-request",
          "humanAssistance",
          { contract: assistanceContract },
        )));
      } else if (this.scenario === "validation-failure" && answered === "worker-start-event") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => {
          this.emit("message", {
            protocolVersion: 3,
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
      } else if (this.scenario !== "assistance-completion" && answered === "worker-commit-started") {
        if (this.scenario === "commit-crash") {
          setImmediate(() => {
            this.emit("error", new Error("untrusted provider detail"));
            this.emit("exit", 1);
          });
        }
      } else if (this.scenario !== "assistance-completion" && answered === "worker-start-event") {
        const start = this.workerData as AppWorkflowWorkerStart;
        setImmediate(() => this.emit("message", this.calls.call("worker-commit-started", "commitAttempt", {
          attempt: { phase: "started", attemptId: `attempt-${start.taskRunId}`, product: "financial", total: 1 },
        })));
      }
      return;
    }
    if (frame.kind === "cancel" && this.scenario === "commit-cancel-settled") {
      const start = this.workerData as AppWorkflowWorkerStart;
      // The canonical request stops between items and returns a known cancelled result.
      setImmediate(() => this.emit("message", this.calls.call("worker-commit-settled", "commitAttempt", {
        attempt: { phase: "settled", attemptId: `attempt-${start.taskRunId}`, outcome: "cancelled", committedCount: 0 },
      })));
      return;
    }
    if (frame.kind === "cancel" && this.scenario === "commit-cancel") {
      const start = this.workerData as AppWorkflowWorkerStart;
      setImmediate(() => {
        this.emit("message", {
          protocolVersion: 3,
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
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider, task);
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: {
        LIBRETTO_CLOUD_CTBC_USER_ID: "private-user-id",
        LIBRETTO_CLOUD_CTBC_ACCOUNT: "private-account-id",
        LIBRETTO_CLOUD_CTBC_PASSWORD: "private-password",
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
    });

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
  let runCalls = 0;
  const run = new Proxy({ signal: new AbortController().signal }, {
    get(target, property) {
      if (property === "signal") return target.signal;
      runCalls += 1;
      return async () => undefined;
    },
  });

  await assert.rejects(
    () => runAutomationTaskExecution(task, run as never, {}),
    /App workflow definition is unavailable/,
  );
  assert.equal(runCalls, 0);
});

test("resuming a missing App run fails closed without invoking a workflow", async () => {
  let workflowCalls = 0;
  const persistence = {
    async taskRunById() { return null; },
  };
  const runner = createAutomationRunner({ runtime: createAutomationRuntimeState() });
  await assert.rejects(
    () => runner.start("einvoice-personal-invoices", { automation: persistence } as never, {
      taskRunId: "missing-app-run",
      runExecution: async () => {
        workflowCalls += 1;
        return { summary: null, failure: null };
      },
    }),
    /Missing automation task run: missing-app-run/u,
  );
  assert.equal(workflowCalls, 0);
  assert.equal(runner.hasActive(), false);
});

class NonBrowserFakeWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  readonly start: AppWorkflowWorkerStart;
  readonly exchange: boolean;
  private readonly calls = new ScriptedHostCalls();
  constructor(start: AppWorkflowWorkerStart) {
    super();
    this.start = start;
    this.exchange = start.workflowId === "exchange-rates";
    setImmediate(() => {
      this.emit("online");
      this.emit("message", this.calls.call("run-started-id", "event", {
        event: {
          runId: start.taskRunId,
          stage: "preparation",
          outcome: "started", code: "run-started",
          occurredAt: "2026-09-26T00:00:00.000Z",
        },
      }));
    });
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    const answered = this.calls.answered(frame);
    if (answered === "run-started-id") {
      if (this.exchange) {
        setImmediate(() => this.emit("message", this.calls.call("progress-id", "exchangeRateProgress", {
          phaseCode: "complete",
          completed: 3,
          total: 3,
          percent: 100,
        })));
      } else this.complete();
    } else if (answered === "progress-id") {
      this.complete();
    } else if (frame.kind === "cancel") {
      setImmediate(() => {
        this.emit("message", { protocolVersion: 3, kind: "cancelled", taskRunId: this.start.taskRunId });
        this.emit("exit", 0);
      });
    }
  }
  private complete() {
    setImmediate(() => {
      this.emit("message", {
        protocolVersion: 3,
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
    const database = await createTestPGlite("operational");
    const store = new PGliteStore(database);
    try {
      const provider = createPgliteOperationalProvider(store);
      let start: AppWorkflowWorkerStart | undefined;
      const taskRunId = await createRun(provider, task);
      const result = await executeTaskRunForCheck(task, provider.automation, {
        taskRunId,
        pgliteRpc: { endpoint: "/tmp/worker-test.sock", token: "a".repeat(32) },
        launchEnv: {},
        workflowBrowserPortFactory: () => { throw new Error("Nonbrowser task opened a browser."); },
        appWorkflowWorkerFactory: (_path, options) => {
          start = options.workerData as AppWorkflowWorkerStart;
          return new NonBrowserFakeWorker(start);
        },
      });
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
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  const persistedEvents = new Set<string>();
  try {
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
    };

    const runScenario = async (
      scenario: WorkerScenario,
      options: { forceTerminated?: boolean } = {},
    ) => {
      const taskRunId = await createRun(provider, task);
      let startData: AppWorkflowWorkerStart | undefined;
      let worker: TaskExecutionFakeWorker | undefined;
      let active: ActiveAutomationTaskRun | undefined;
      let resolveWorkerCreated!: () => void;
      const workerCreated = new Promise<void>((resolve) => { resolveWorkerCreated = resolve; });
      let assistanceRequest: AppWorkflowHumanAssistanceRequest | undefined;
      const execution = executeTaskRunForCheck(task, provider.automation, {
        taskRunId,
        // The scenario resumes the stage itself; the route only keeps it
        // from failing closed as unrouted.
        assistanceRoute: (request) => { assistanceRequest = request; },
        pgliteRpc: CHECK_PGLITE_RPC,
        launchEnv,
        onRunOpened: (run) => {
          active = run;
        },
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
          // Race force termination with a worker's interrupted commit, after
          // startup. A pre-start cancellation would never create the worker.
          worker.once("exit", () => {
            if (options.forceTerminated) void active?.requestStop("forced");
          });
          return worker;
        },
      });

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
          void active?.requestStop("cancelled");
          await execution;
          throw error;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      assert.ok(startData, "the task creates the supervised worker");
      assert.equal(startData.workflowId, task.workflowId);
      assert.equal(startData.input && typeof startData.input, "object");
      assert.deepEqual(startData.pgliteRpc, CHECK_PGLITE_RPC);
      assert.ok(startData.browserConnection);
      assert.match(startData.browserConnection.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.ok(startData.browserConnection.targetId.length > 0);
      assert.equal(taskRunId, startData.taskRunId);

      if (scenario === "assistance-completion") {
        const waitingDeadline = Date.now() + 10_000;
        while (Date.now() < waitingDeadline) {
          if (assistanceRequest) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(assistanceRequest, "the worker's request reaches the execution's route");
        assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "waiting_for_human");
        await completeAppWorkflowHumanAssistance(assistanceRequest);
      } else if (scenario === "commit-cancel" || scenario === "commit-cancel-settled") {
        const commitDeadline = Date.now() + 10_000;
        while (Date.now() < commitDeadline) {
          if ((await provider.automation.commitAttempts(taskRunId)).length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal((await provider.automation.commitAttempts(taskRunId)).length, 1);
        void active?.requestStop("cancelled");
      }

      const result = await execution;
      assert.equal(worker?.eventAckAfterPersistence, true);
      return { result, taskRunId, run: await provider.automation.taskRunById(taskRunId) };
    };

    const completed = await runScenario("assistance-completion");
    assert.equal(completed.result.status, "completed");
    assert.equal(completed.run?.status, "completed");
    assert.ok(completed.run?.events.some((event) => event.code === "worker-check-started"));

    const crashed = await runScenario("commit-crash");
    assert.equal(crashed.result.status, "failed");
    assert.equal(crashed.run?.status, "failed");
    assert.equal(crashed.run?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
    // ADR 0056: the worker died between start and settlement, and the record says so.
    assert.deepEqual(await provider.automation.commitAttempts(crashed.taskRunId), [{
      attemptId: `attempt-${crashed.taskRunId}`, product: "financial", total: 1, outcome: null, committedCount: 0,
    }]);

    const cancelled = await runScenario("commit-cancel");
    assert.equal(cancelled.result.status, "failed");
    assert.equal(cancelled.run?.status, "failed");
    assert.equal(cancelled.run?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");

    // ADR 0056: a settlement that arrives after the stop request still decides the outcome.
    const settledCancel = await runScenario("commit-cancel-settled");
    assert.equal(settledCancel.run?.status, "cancelled");
    assert.equal(settledCancel.run?.appWorkflowOutcome?.errorCode, "cancelled");
    assert.deepEqual(await provider.automation.commitAttempts(settledCancel.taskRunId), [{
      attemptId: `attempt-${settledCancel.taskRunId}`, product: "financial", total: 1, outcome: "cancelled", committedCount: 0,
    }]);

    const forced = await runScenario("commit-crash", { forceTerminated: true });
    assert.equal(forced.result.status, "failed", "force termination cannot mask an unknown commit");
    assert.equal(forced.run?.status, "failed");
    assert.equal(forced.run?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
    assert.notEqual(forced.run?.terminationMode, "forced", "the run was not finalized as cancellation");
  } finally {
    await store.close();
  }
});

test("E-Invoice uses the supervised Chromium worker and keeps runtime identity until its run owner finishes", async () => {
  const task = taskById("einvoice-personal-invoices");
  assert.ok(task);
  assert.ok(task.workflowId);
  assert.equal(workflowBrowserProfileForTask(task.workflowId), undefined);
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    const provider = createPgliteOperationalProvider(store);
    const runtimeIdentity = {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: "151.0.0.0",
    } as const;
    const launchEnv = {
      LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
      [einvoicePasswordFixtureEnvKey]: "fixture-password",
    };
    const taskRunId = await createRun(provider, task);
    let workerStart: AppWorkflowWorkerStart | undefined;
    let hostInput: Record<string, unknown> | undefined;
    const active = await openTaskRunForCheck(provider.automation, taskRunId);
    const outcome = await runAutomationTaskExecution(task, active, {
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv,
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
    });

    assert.equal(outcome.failure, null);
    assert.ok(workerStart, "E-Invoice creates the supervised worker");
    assert.equal(workerStart.workflowId, "einvoice-personal-invoices");
    assert.ok(workerStart.browserConnection, "the worker receives the App browser connection");
    assert.equal(typeof hostInput?.onRuntimeIdentity, "function");
    assert.equal(hostInput?.browserProfile, undefined, "E-Invoice uses the shared default profile");
    assert.equal(taskRunId, workerStart.taskRunId);

    const activeRun = await provider.automation.taskRunById(taskRunId);
    assert.equal(activeRun?.status, "running", "execution leaves the terminal transition to its owner");
    assert.deepEqual(activeRun?.browserRuntime, runtimeIdentity);
    assert.deepEqual(active.current().browserRuntime, runtimeIdentity, "the run owner wrote the identity it holds");
    assert.equal(activeRun?.appWorkflowOutcome, null);

    await active.finish(outcome);

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
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    const provider = createPgliteOperationalProvider(store);
    const runtimeIdentity = {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: "151.0.0.0",
    } as const;
    const launchEnv = {
      LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
      [einvoicePasswordFixtureEnvKey]: "fixture-password",
    };
    const taskRunId = await createRun(provider, task);
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      pgliteRpc: CHECK_PGLITE_RPC,
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
    });

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
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider, task);
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: {
        LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER: "fixture-phone",
        [einvoicePasswordFixtureEnvKey]: "fixture-password",
      },
      workflowBrowserPortFactory: () => {
        throw new BrowserRuntimeConfigurationError("unsupported-profile");
      },
      appWorkflowWorkerFactory: () => {
        throw new Error("An unsupported profile must fail before worker startup.");
      },
    });

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
  const database = await createTestPGlite("operational");
  const store = new PGliteStore(database);
  try {
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
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider, task);
    await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: {
        LIBRETTO_CLOUD_CTBC_USER_ID: "synthetic-user",
        LIBRETTO_CLOUD_CTBC_ACCOUNT: "synthetic-account",
        LIBRETTO_CLOUD_CTBC_PASSWORD: "synthetic-password",
      },
      workflowBrowserPortFactory: () => ({ async withPage(run) { return await run({} as never); } }),
      appWorkflowBrowserConnectionForRun: (id) => ({ endpoint: "http://127.0.0.1:43121", targetId: `host-page-${id}` }),
      appWorkflowWorkerFactory: (_path, options) => new TaskExecutionFakeWorker(options.workerData, "product-invariant", () => true),
    });
    const run = await provider.automation.taskRunById(taskRunId);
    assert.equal(run?.appWorkflowOutcome?.errorCode, "workflow-failed");
    assert.equal(run?.appWorkflowOutcome?.summary?.counts.committedCount, 4);
    assert.equal(run?.status, "failed", "a fatal invariant remains a failure with retained receipts");
  } finally {
    await store.close();
  }
});

const ctbcLaunchEnv = {
  [["LIBRETTO", "CLOUD", "CTBC", "USER", "ID"].join("_")]: "synthetic-user-id",
  [["LIBRETTO", "CLOUD", "CTBC", "ACCOUNT"].join("_")]: "synthetic-account",
  [["LIBRETTO", "CLOUD", "CTBC", "PASSWORD"].join("_")]: "synthetic-password",
};
const checkHostPage: Pick<AutomationTaskExecutionOptions, "workflowBrowserPortFactory" | "appWorkflowBrowserConnectionForRun"> = {
  workflowBrowserPortFactory: () => ({
    async withPage(run) { return await run({} as never); },
  }),
  appWorkflowBrowserConnectionForRun: (runId) => ({
    endpoint: "http://127.0.0.1:43121",
    targetId: `host-page-${runId}`,
  }),
};

test("an execution logs each worker and host event once, unmoved by the store cap and pruning, and proves the unrouted solver", async () => {
  const task = taskById("ctbc-statements");
  assert.ok(task);
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider, task);
    // An earlier execution left the store at its 200-event cap, so the stored
    // tail after this execution's appends holds nothing past the count a
    // slice would start at, and the host signal would be lost to it.
    for (let index = 0; index < 200; index += 1) {
      await provider.automation.appendRunEvent({
        runId: taskRunId, stage: "collection", outcome: "advanced", code: `earlier-${index}`,
        occurredAt: new Date().toISOString(),
      });
    }
    const executions: WorkflowExecution[] = [];
    // No route is registered: the host writes solver-route-unavailable and the
    // worker only sees its rejected request.
    const result = await executeTaskRunForCheck(task, provider.automation, {
      taskRunId,
      executions,
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: ctbcLaunchEnv,
      ...checkHostPage,
      appWorkflowWorkerFactory: (_path, options) =>
        new TaskExecutionFakeWorker(options.workerData, "assistance-completion", () => true),
    });
    assert.equal(result.outcome.errorCode, "verification-configuration-failed");
    assert.equal(executions.length, 1);
    assert.deepEqual(
      executions[0]!.events().map((event) => event.code),
      ["worker-check-started", "solver-route-unavailable"],
    );
    // The fake worker dates its event over 30 days back, so the store pruned it
    // when the host signal landed; the execution log is unaffected.
    const stored = (await provider.automation.taskRunById(taskRunId))!.events;
    assert.equal(stored.length, 200);
    assert.deepEqual(stored.slice(-2).map((event) => event.code), ["earlier-199", "solver-route-unavailable"]);
  } finally {
    await store.close();
  }
});

test("two executions of one run each log only their own events, and only the retry's are marked retrying", async () => {
  const task = taskById("ctbc-statements");
  assert.ok(task);
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const taskRunId = await createRun(provider, task);
    const executions: WorkflowExecution[] = [];
    const run = observingExecutions(await openTaskRunForCheck(provider.automation, taskRunId), executions);
    const execute = (attempt: number) => runAutomationTaskExecution(task, run, {
      attempt,
      maxAttempts: 2,
      executionId: `round-${attempt}`,
      retrying: attempt > 1,
      pgliteRpc: CHECK_PGLITE_RPC,
      launchEnv: ctbcLaunchEnv,
      ...checkHostPage,
      appWorkflowWorkerFactory: (_path, options) =>
        new TaskExecutionFakeWorker(options.workerData, "validation-failure", () => true),
    });
    assert.equal((await execute(1)).failure?.code, "source-validation-failed");
    assert.equal(run.currentExecution(), null, "the execution ends with its workflow start");
    const second = await execute(2);
    assert.equal(second.failure?.code, "source-validation-failed");
    assert.deepEqual(executions.map((execution) => execution.executionId), ["round-1", "round-2"]);
    assert.deepEqual(executions[0]!.events().map((event) => [event.code, event.retrying]), [["worker-check-started", undefined]]);
    assert.deepEqual(executions[1]!.events().map((event) => [event.code, event.retrying]), [["worker-check-started", true]]);
    const stored = (await provider.automation.taskRunById(taskRunId))!.events;
    assert.deepEqual(stored.map((event) => [event.code, event.retrying]), [
      ["worker-check-started", undefined],
      ["worker-check-started", true],
    ]);
    await run.finish(second);
  } finally {
    await store.close();
  }
});
