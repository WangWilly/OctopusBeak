import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import type { PGliteWorkflowRpc } from "../../../../electron/pglite-child-rpc-client.ts";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";
import { openActiveTaskRun, type ActiveAutomationTaskRun, type WorkflowExecution } from "./active-task-run.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import { parseAppWorkflowWorkerOutboundFrame } from "./app-workflow-worker-protocol.ts";
import {
  runAppWorkflowWorker,
  type AppWorkflowWorkerRuntimeOptions,
} from "./app-workflow-worker-runtime.ts";
import type { AppWorkflowWorkerHandle } from "./app-workflow-worker-supervisor.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistencePort, AutomationTaskRun } from "./store.ts";
import {
  runAutomationTaskExecution,
  type AutomationTaskExecutionOptions,
} from "./task-run-execution.ts";
import type { taskById } from "./tasks.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";

/** A well-formed PGlite endpoint for checks whose worker never dials it. */
export const CHECK_PGLITE_RPC: PGliteWorkflowRpc = Object.freeze({
  endpoint: "http://127.0.0.1:43121/rpc",
  token: "a".repeat(32),
});

/** Ports a check gives the worker in place of the ones it builds from the PGlite child RPC. */
export type CheckWorkerPorts = Omit<AppWorkflowWorkerRuntimeOptions, "port" | "workerData">;

/** The App worker runtime on a MessageChannel instead of a thread, so the supervisor and runtime exchange real frames. */
export function inProcessAppWorkflowWorker(
  workerData: unknown,
  ports: CheckWorkerPorts = {},
): AppWorkflowWorkerHandle {
  const channel = new MessageChannel();
  const worker = new EventEmitter() as EventEmitter & AppWorkflowWorkerHandle;
  channel.port2.on("message", (value: unknown) => {
    worker.emit("message", value);
    const { kind } = parseAppWorkflowWorkerOutboundFrame(value);
    if (kind === "completed" || kind === "failed" || kind === "cancelled") {
      channel.port2.close();
      worker.emit("exit", 0);
    }
  });
  Object.assign(worker, {
    postMessage: (frame: unknown) => channel.port2.postMessage(frame),
    terminate: () => {
      channel.port1.close();
      worker.emit("exit", 1);
      return 1;
    },
  });
  setImmediate(() => {
    worker.emit("online");
    void runAppWorkflowWorker({ ...ports, port: channel.port1, workerData });
  });
  return worker;
}

const hostPageForWorker: WorkflowBrowserPort = {
  async withPage(run) { return await run({} as never); },
};

/** The host keeps its production wiring; the page and RPC-backed ports reach the worker from the check. */
function supervisedWithCheckWorker(
  options: AutomationTaskExecutionOptions,
  workerPorts: CheckWorkerPorts,
): AutomationTaskExecutionOptions {
  let workerBrowser: WorkflowBrowserPort | undefined;
  return {
    ...options,
    pgliteRpc: options.pgliteRpc ?? CHECK_PGLITE_RPC,
    workflowBrowserPortFactory: (input) => {
      workerBrowser = options.workflowBrowserPortFactory?.(input);
      return hostPageForWorker;
    },
    appWorkflowBrowserConnectionForRun: (runId) => ({
      endpoint: "http://127.0.0.1:43121",
      targetId: `host-page-${runId}`,
    }),
    appWorkflowWorkerFactory: (_path, worker) => inProcessAppWorkflowWorker(worker.workerData, {
      ...workerPorts,
      ...(workerBrowser ? { browser: workerBrowser } : {}),
    }),
  };
}

/** Own an existing persisted run in a check, publishing to a private runtime snapshot. */
export async function openTaskRunForCheck(
  persistence: AutomationPersistencePort,
  taskRunId: string,
): Promise<ActiveAutomationTaskRun> {
  const row = await persistence.taskRunById(taskRunId);
  if (!row) throw new Error(`Missing automation task run: ${taskRunId}`);
  return openActiveTaskRun({
    run: row,
    persistence,
    runtime: createAutomationRuntimeState(),
  });
}

/** The run with every Workflow execution it begins pushed to `executions`, so a check can read a log after its execution ended. */
export function observingExecutions(
  run: ActiveAutomationTaskRun,
  executions: WorkflowExecution[],
): ActiveAutomationTaskRun {
  return {
    ...run,
    beginExecution(executionId) {
      const execution = run.beginExecution(executionId);
      executions.push(execution);
      return execution;
    },
  };
}

/** Own an existing run and begin one Workflow execution on it, as the executor does before the worker starts. */
export async function openExecutionForCheck(
  persistence: AutomationPersistencePort,
  taskRunId: string,
  executionId = randomUUID(),
): Promise<{ run: ActiveAutomationTaskRun; execution: WorkflowExecution }> {
  const run = await openTaskRunForCheck(persistence, taskRunId);
  return { run, execution: run.beginExecution(executionId) };
}

/** Request assistance the way one Workflow execution does: the execution begins before the request and ends after it. */
export async function requestAssistanceForCheck(
  run: ActiveAutomationTaskRun,
  contract: HumanAssistanceContractInput,
  signal: AbortSignal,
) {
  const execution = run.beginExecution(randomUUID());
  try {
    return await createAppWorkflowHumanAssistancePort({ run, execution }).request(contract, signal);
  } finally {
    execution.end();
  }
}

/** Execute one workflow round over an existing run and finish it, as the runner does. */
export async function executeTaskRunForCheck(
  task: NonNullable<ReturnType<typeof taskById>>,
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions & Readonly<{
    taskRunId: string;
    onRunOpened?: (run: ActiveAutomationTaskRun) => void;
    /** Receives each Workflow execution the round begins. */
    executions?: WorkflowExecution[];
    /** Run the production supervised path against an in-process worker holding these ports. */
    workerPorts?: CheckWorkerPorts;
  }>,
): Promise<{
  status: AutomationTaskRun["status"];
  taskRunId: string;
  run: AutomationTaskRun;
  outcome: TypedWorkflowOutcome;
}> {
  const { taskRunId, onRunOpened, executions, workerPorts, ...executionOptions } = options;
  const opened = await openTaskRunForCheck(persistence, taskRunId);
  const active = executions ? observingExecutions(opened, executions) : opened;
  onRunOpened?.(active);
  const report = await runAutomationTaskExecution(
    task,
    active,
    workerPorts ? supervisedWithCheckWorker(executionOptions, workerPorts) : executionOptions,
  );
  const run = await active.finish(report);
  return { status: run.status, taskRunId, run, outcome: run.appWorkflowOutcome ?? { errorCode: null, summary: null } };
}
