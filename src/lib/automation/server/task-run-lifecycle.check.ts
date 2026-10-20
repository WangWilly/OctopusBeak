import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { after } from "node:test";
import type { WorkerOptions } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import type { AutomationRuntimeTaskSnapshot } from "$lib/desktop/api.ts";
import {
  cancelAutomationTask,
  forceTerminateAutomationTask,
  hasActiveAutomationTask,
  startAutomationTask,
} from "./runner.ts";
import { automationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import type { AppWorkflowWorkerHandle } from "./app-workflow-worker-supervisor.ts";
import type { AppWorkflowWorkerInboundFrame, AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";

const database = await PGlite.create();
const store = new PGliteStore(database);
await applyPgliteOperationalBaseline(store);
after(() => database.close());

function providerWith(automation = createPgliteOperationalProvider(store).automation) {
  return {
    automation,
    pgliteWorkflow: {
      required: true,
      env: {
        [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "p".repeat(32),
      },
    },
  } as unknown as AutomationPersistenceProvider;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

type WorkerMode = "completes" | "stops-on-cancel" | "ignores-cancel";

class ScriptedWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  terminated = false;
  readonly started = deferred();
  readonly start: AppWorkflowWorkerStart;
  readonly mode: WorkerMode;
  constructor(start: AppWorkflowWorkerStart, mode: WorkerMode) {
    super();
    this.start = start;
    this.mode = mode;
    setImmediate(() => {
      this.emit("online");
      this.emit("message", {
        protocolVersion: 2,
        kind: "event",
        eventId: "lifecycle-start",
        event: {
          runId: start.taskRunId,
          stage: "preparation",
          code: "run-started",
          occurredAt: "2026-10-20T00:00:00.000Z",
        },
      });
    });
  }
  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    if (frame.kind === "event-ack" && frame.eventId === "lifecycle-start") {
      this.started.resolve();
      if (this.mode === "completes") {
        setImmediate(() => {
          this.emit("message", { protocolVersion: 2, kind: "completed", taskRunId: this.start.taskRunId, summary: null });
          this.emit("exit", 0);
        });
      }
    } else if (frame.kind === "cancel" && this.mode === "stops-on-cancel") {
      setImmediate(() => this.emit("exit", 0));
    }
  }
  terminate() {
    this.terminated = true;
    setImmediate(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

/** Run the production execution path with a scripted supervised worker. */
function workerExecution(mode: WorkerMode, workers: ScriptedWorker[] = []): typeof runAutomationTaskExecution {
  return (task, persistence, options, onRunCreated) => runAutomationTaskExecution(
    task,
    persistence,
    {
      ...options,
      appWorkflowWorkerFactory: (_path: string, workerOptions: WorkerOptions) => {
        const worker = new ScriptedWorker(workerOptions.workerData as AppWorkflowWorkerStart, mode);
        workers.push(worker);
        return worker;
      },
    },
    onRunCreated,
  );
}

test(
  "a cancellation that arrives while the run row is being created ends that run and leaves the previous run's state alone",
  { todo: "Active automation task run owns the run from claim" },
  async () => {
    const provider = providerWith();
    const firstFinished = deferred<AutomationTaskRun>();
    const first = await startAutomationTask("exchange-rates", provider, {
      runExecution: workerExecution("completes"),
      onFinished: firstFinished.resolve,
    });
    assert.equal((await firstFinished.promise).status, "completed");

    const published: AutomationRuntimeTaskSnapshot[] = [];
    const unsubscribe = automationRuntimeState.subscribe((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.taskId === "exchange-rates");
      if (task) published.push(task);
    });
    const creating = deferred();
    const releaseCreate = deferred();
    const base = createPgliteOperationalProvider(store).automation;
    const delayed = providerWith(new Proxy(base, {
      get(target, property) {
        if (property !== "createTaskRun") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (input: Parameters<typeof base.createTaskRun>[0]) => {
          creating.resolve();
          await releaseCreate.promise;
          return target.createTaskRun(input);
        };
      },
    }));
    const finished: AutomationTaskRun[] = [];
    try {
      const starting = startAutomationTask("exchange-rates", delayed, {
        runExecution: workerExecution("completes"),
        onFinished: (run) => finished.push(run),
      });
      await creating.promise;
      await cancelAutomationTask("exchange-rates", delayed);
      releaseCreate.resolve();
      const second = await starting;
      await until(() => !hasActiveAutomationTask(), "the cancelled run never released its task");
      await until(() => finished.length > 0, "the cancelled run never reported that it finished");

      assert.equal((await base.taskRunById(second.runId))?.status, "cancelled");
      assert.deepEqual(finished.map((run) => [run.taskRunId, run.status]), [[second.runId, "cancelled"]]);
      assert.ok(
        !published.some((task) => task.runId === first.runId && task.status === "cancelling"),
        "the completed previous run was republished as cancelling",
      );
    } finally {
      releaseCreate.resolve();
      unsubscribe();
      await until(() => !hasActiveAutomationTask(), "the run under test did not settle");
    }
  },
);

test(
  "force-quit ends the workflow worker immediately and records a forced cancellation",
  { todo: "force-quit terminates without the cancellation grace" },
  async () => {
    const provider = providerWith();
    const workers: ScriptedWorker[] = [];
    const finished = deferred<AutomationTaskRun>();
    const started = await startAutomationTask("exchange-rates", provider, {
      runExecution: workerExecution("ignores-cancel", workers),
      onFinished: finished.resolve,
    });
    try {
      await until(() => workers.length === 1, "the workflow worker never started");
      await workers[0]!.started.promise;
      const forcedAt = Date.now();
      await forceTerminateAutomationTask("exchange-rates", provider, started.runId);
      const elapsed = Date.now() - forcedAt;

      assert.equal(workers[0]!.terminated, true);
      assert.ok(elapsed < 1_000, `force-quit waited ${elapsed}ms for the cancellation grace`);
      const run = await finished.promise;
      assert.equal(run.status, "cancelled");
      assert.equal(run.terminationMode, "forced");
    } finally {
      await until(() => !hasActiveAutomationTask(), "the forced run did not settle");
    }
  },
);

test(
  "a run whose runner fails before execution still reports a terminal finish",
  { todo: "finish notifies every terminal run" },
  async () => {
    const provider = { automation: createPgliteOperationalProvider(store).automation } as AutomationPersistenceProvider;
    const finished = deferred<AutomationTaskRun>();
    const started = await startAutomationTask("exchange-rates", provider, {
      runExecution: workerExecution("completes"),
      onFinished: finished.resolve,
    });
    try {
      const run = await Promise.race([
        finished.promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      assert.ok(run, "onFinished was not called for a run the runner failed");
      assert.equal(run.taskRunId, started.runId);
      assert.equal(run.status, "failed");
    } finally {
      await until(() => !hasActiveAutomationTask(), "the failed run did not settle");
    }
  },
);

test(
  "the operational store refuses to move a cancelling run back to an earlier active status",
  { todo: "store transitions follow the Active automation task run table" },
  async () => {
    const automation = createPgliteOperationalProvider(store).automation;
    const { taskRunId } = await automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-10-20T00:00:00.000Z",
    });
    assert.equal((await automation.transitionTaskRunToActive(taskRunId, { status: "cancelling" })).applied, true);

    for (const status of ["running", "waiting_for_human", "queued", "preparing"] as const) {
      const regressed = await automation.transitionTaskRunToActive(taskRunId, { status });
      assert.deepEqual(regressed, { status: "cancelling", applied: false }, `cancelling moved back to ${status}`);
    }
    await assert.rejects(
      automation.updateTaskRun(taskRunId, { status: "running" } as Parameters<typeof automation.updateTaskRun>[1]),
      /status/u,
    );
    assert.equal((await automation.taskRunById(taskRunId))?.status, "cancelling");
    await automation.transitionTaskRunToTerminal(taskRunId, {
      status: "cancelled",
      finishedAt: "2026-10-20T00:00:01.000Z",
    });
  },
);
