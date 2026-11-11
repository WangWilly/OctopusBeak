import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import type { PGliteWorkflowRpc } from "../../../../electron/pglite-child-rpc-client.ts";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";
import { openActiveTaskRun, type ActiveAutomationTaskRun, type WorkflowExecution } from "./active-task-run.ts";
import {
  createAppWorkflowHumanAssistancePort,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import { parseAppWorkflowWorkerOutboundFrame, type AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import {
  runAppWorkflowWorker,
  type AppWorkflowWorkerRuntimeOptions,
} from "./app-workflow-worker-runtime.ts";
import type { AppWorkflowBrowserHostInput } from "./app-browser-host.ts";
import type { AppWorkflowWorkerHandle, ExecutionHost } from "./execution-host.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistencePort, AutomationTaskRun } from "./store.ts";
import { createTaskRunExecution, type WorkflowExecutionRound } from "./task-run-execution.ts";
import {
  resolveTaskRunPlan,
  type TaskRunPlan,
  type TaskRunPlanDependencies,
} from "./task-run-plan.ts";
import { taskById, type AutomationTask } from "./tasks.ts";
import {
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_SETTINGS_FILE,
  createAutomationCredentialStore,
  createAutomationSettingsStore,
  type AutomationCredentialCodec,
  type AutomationCredentialStore,
  type AutomationSettingsFile,
  type AutomationSettingsStore,
} from "./config-files.ts";
import { sourceVerificationFacts } from "./verification-routing.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";

/** A well-formed PGlite endpoint for checks whose worker never dials it. */
export const CHECK_PGLITE_RPC: PGliteWorkflowRpc = Object.freeze({
  endpoint: "http://127.0.0.1:43121/rpc",
  token: "a".repeat(32),
});

/** Reversible stand-in for safeStorage; a check reads back what it wrote. */
export const CHECK_CREDENTIAL_CODEC: AutomationCredentialCodec = Object.freeze({
  encrypt: (text: string) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload: string) => Buffer.from(payload, "base64").toString("utf8"),
});

/** By default the credentials file in whatever directory the check is in when it reads. */
export function credentialStoreForCheck(
  path: string = AUTOMATION_CREDENTIALS_FILE,
): AutomationCredentialStore {
  return createAutomationCredentialStore(path, CHECK_CREDENTIAL_CODEC);
}

/**
 * What the host hands the runner: credentials, settings and user data, all
 * in `directory`. The default is whatever directory the check is in.
 */
export function runnerHostForCheck(directory = ".") {
  return {
    credentials: credentialStoreForCheck(join(directory, AUTOMATION_CREDENTIALS_FILE)),
    settings: settingsStoreForCheck(join(directory, AUTOMATION_SETTINGS_FILE)),
    userDataDirectory: resolve(directory),
  };
}

/** Start one task through the runtime's admission; `settled` is its terminal record. */
export async function startForCheck(runtime: Pick<AutomationRuntime, "start">, taskId: string) {
  let settle!: (run: AutomationTaskRun | null) => void;
  const settled = new Promise<AutomationTaskRun | null>((resolve) => { settle = resolve; });
  const [result] = await runtime.start([taskId], {
    onSettled: ([settled]) => settle(settled?.status === "started" ? settled.run : null),
  });
  if (result?.status !== "started") throw result?.status === "error" ? result.error : new Error(`${taskId} did not start`);
  return { runId: result.runId, settled };
}

/** By default the settings file in whatever directory the check is in when it reads. */
export function settingsStoreForCheck(
  path: string = AUTOMATION_SETTINGS_FILE,
): AutomationSettingsStore {
  return createAutomationSettingsStore(path);
}

/**
 * The task's plan as the runner resolves it, with the check's PGlite
 * endpoint, credentials, settings and user data (the check's directory)
 * unless the check names them.
 */
export function planForCheck(
  task: AutomationTask,
  dependencies: Partial<TaskRunPlanDependencies> = {},
): TaskRunPlan {
  return resolveTaskRunPlan(task, {
    pgliteRpc: CHECK_PGLITE_RPC,
    credentials: credentialStoreForCheck(),
    settings: settingsStoreForCheck(),
    userDataDirectory: process.cwd(),
    ...dependencies,
  });
}

/**
 * The part of a task's plan the CAPTCHA Retry Campaign and its round adapter
 * read, without the workflow input a full plan builds from settings.
 */
export function routingPlanForCheck(
  taskId: string,
  launchVerificationSettings: AutomationSettingsFile = {},
): Pick<TaskRunPlan, "task" | "verification" | "launchVerificationSettings"> {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  return { task, verification: sourceVerificationFacts(taskId), launchVerificationSettings };
}

/** A run's first round, as the CAPTCHA Retry Campaign opens it. */
export function firstRoundForCheck(
  round: Partial<WorkflowExecutionRound> = {},
): WorkflowExecutionRound {
  return { attempt: 1, maxAttempts: 1, retrying: false, executionId: randomUUID(), ...round };
}

/** Ports a check gives the worker in place of the ones it builds from the PGlite child RPC. */
export type CheckWorkerPorts = Omit<AppWorkflowWorkerRuntimeOptions, "port" | "browser">;

export type InProcessCheckHostOptions = CheckWorkerPorts & Readonly<{
  /** The browser a browser workflow's worker runs in, built from the page the round asked for. */
  browser?: (page: AppWorkflowBrowserHostInput) => WorkflowBrowserPort;
  /** Frames a check scripts in place of the real worker. */
  scriptedWorker?: (start: AppWorkflowWorkerStart) => AppWorkflowWorkerHandle;
}>;

/** The App worker runtime on a MessageChannel instead of a thread, so the supervisor and runtime exchange real frames. */
function inProcessWorker(
  start: AppWorkflowWorkerStart,
  options: Omit<AppWorkflowWorkerRuntimeOptions, "port">,
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
    void runAppWorkflowWorker(start, { ...options, port: channel.port1 });
  });
  return worker;
}

/**
 * An execution host that opens no browser: the round's worker is the real
 * worker runtime in this process holding the check's ports, or the check's
 * scripted worker.
 */
export function inProcessCheckHost(options: InProcessCheckHostOptions = {}): ExecutionHost {
  const { browser, scriptedWorker, ...ports } = options;
  const pages = new Map<string, WorkflowBrowserPort>();
  return {
    async withPage(page, use) {
      if (browser) pages.set(page.taskRunId, browser(page));
      try {
        return await use();
      } finally {
        pages.delete(page.taskRunId);
      }
    },
    launchWorker(start) {
      if (scriptedWorker) return scriptedWorker(start);
      const page = pages.get(start.taskRunId);
      return inProcessWorker(start, { ...ports, ...(page ? { browser: page } : {}) });
    },
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
    beginExecution(executionId, executionOptions) {
      const execution = run.beginExecution(executionId, executionOptions);
      executions.push(execution);
      return execution;
    },
  };
}

/** Own an existing run and begin one Workflow execution on it, as the executor does before the worker starts. */
export async function openExecutionForCheck(
  persistence: AutomationPersistencePort,
  taskRunId: string,
  assistanceRoute?: HumanAssistanceRoute,
): Promise<{ run: ActiveAutomationTaskRun; execution: WorkflowExecution }> {
  const run = await openTaskRunForCheck(persistence, taskRunId);
  return { run, execution: run.beginExecution(randomUUID(), { assistanceRoute }) };
}

/**
 * Request assistance the way one Workflow execution does: the execution
 * begins with `options.assistanceRoute`, as the executor's does, before the
 * request and ends after it.
 */
export async function requestAssistanceForCheck(
  run: ActiveAutomationTaskRun,
  options: Pick<WorkflowExecutionRound, "assistanceRoute">,
  contract: HumanAssistanceContractInput,
  signal: AbortSignal,
) {
  const execution = run.beginExecution(randomUUID(), { assistanceRoute: options.assistanceRoute });
  try {
    return await createAppWorkflowHumanAssistancePort({ run, execution }).request(contract, signal);
  } finally {
    execution.end();
  }
}

/** Execute one workflow round over an existing run and finish it, as the runner does. */
export async function executeTaskRunForCheck(
  task: AutomationTask,
  persistence: AutomationPersistencePort,
  options: Partial<TaskRunPlanDependencies>
    & Partial<WorkflowExecutionRound>
    & Readonly<{
      taskRunId: string;
      executionHost: ExecutionHost;
      onRunOpened?: (run: ActiveAutomationTaskRun) => void;
      /** Receives each Workflow execution the round begins. */
      executions?: WorkflowExecution[];
    }>,
): Promise<{
  status: AutomationTaskRun["status"];
  taskRunId: string;
  run: AutomationTaskRun;
  outcome: TypedWorkflowOutcome;
}> {
  const {
    taskRunId, onRunOpened, executions,
    pgliteRpc, credentials, settings, userDataDirectory, launchEnv, launchVerificationSettings,
    attempt, maxAttempts, retrying, executionId, assistanceRoute, executionHost,
  } = options;
  const plan = planForCheck(task, {
    ...(pgliteRpc ? { pgliteRpc } : {}),
    ...(credentials ? { credentials } : {}),
    ...(settings ? { settings } : {}),
    ...(userDataDirectory ? { userDataDirectory } : {}),
    launchEnv,
    launchVerificationSettings,
  });
  const round = firstRoundForCheck({
    ...(attempt === undefined ? {} : { attempt }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(retrying === undefined ? {} : { retrying }),
    ...(executionId === undefined ? {} : { executionId }),
    assistanceRoute,
  });
  const opened = await openTaskRunForCheck(persistence, taskRunId);
  const active = executions ? observingExecutions(opened, executions) : opened;
  onRunOpened?.(active);
  const report = await createTaskRunExecution(executionHost)(plan, active, round);
  const run = await active.finish(report);
  return { status: run.status, taskRunId, run, outcome: run.appWorkflowOutcome ?? { errorCode: null, summary: null } };
}
