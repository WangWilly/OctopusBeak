import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import type { PGliteWorkflowRpc } from "../../pglite-rpc/pglite-child-rpc-client.ts";
import type { WorkflowBrowserPort } from "../workflow-executor.ts";
import { openActiveTaskRun, type ActiveAutomationTaskRun, type WorkflowExecution } from "./active-task-run.ts";
import {
  createAppWorkflowHumanAssistancePort,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import { parseAppWorkflowWorkerOutboundFrame, type AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import {
  fixedCapabilities,
  runAppWorkflowWorker,
  type AppWorkflowWorkerRuntimeOptions,
} from "./app-workflow-worker-runtime.ts";
import type { AppWorkflowBrowserHostInput } from "./app-browser-host.ts";
import type { AppWorkflowWorkerHandle, ExecutionHost, WorkerLaunch } from "./execution-host.ts";
import { createAutomationRuntime, type AutomationRuntime } from "./automation-runtime.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistencePort, AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import { createTaskRunExecution, type WorkflowExecutionRound } from "./task-run-execution.ts";
import {
  resolveTaskRunPlan,
  type TaskRunPlan,
  type TaskRunPlanDependencies,
} from "./task-run-plan.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById, type AutomationTask } from "./tasks.ts";
import {
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_SETTINGS_FILE,
  createAutomationCredentialStore,
  createAutomationSettingsStore,
  splitAutomationUpdates,
  type AutomationCredentialCodec,
  type AutomationCredentialStore,
  type AutomationSettingsFile,
  type AutomationSettingsStore,
} from "./config-files.ts";
import { sourceVerificationFacts } from "./verification-routing.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";

/** A well-formed PGlite endpoint a check's plan carries; its worker never dials it. */
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

/**
 * A runtime over `provider` whose rounds run on `executionHost`, with every
 * source enabled, the settings `environment` names in settings.json and the
 * rest of it in credentials.json, in a directory of their own. User data is
 * in `userDataDirectory`, the check's directory by default.
 *
 * The CAPTCHA Retry Campaign routes a Verified source's requests to the App's
 * solver, which reads a hosted page `inProcessCheckHost` does not open. A
 * given `assistanceRoute` answers every round's requests in its place; `null`
 * leaves a round with no route, so its requests fail closed. `executions`
 * receives each Workflow execution a round begins.
 */
export function runtimeForCheck(
  provider: Omit<AutomationPersistenceProvider, "pgliteWorkflow">,
  options: Readonly<{
    executionHost: ExecutionHost;
    environment?: NodeJS.ProcessEnv;
    userDataDirectory?: string;
    assistanceRoute?: HumanAssistanceRoute | null;
    executions?: WorkflowExecution[];
  }>,
): AutomationRuntime {
  const { executionHost, assistanceRoute, executions } = options;
  const execute = createTaskRunExecution(executionHost);
  const directory = mkdtempSync(join(tmpdir(), "task-run-check-"));
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  const host = runnerHostForCheck(directory);
  const environment = Object.fromEntries(
    Object.entries(options.environment ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const { settings } = splitAutomationUpdates(environment);
  host.settings.write({
    ...Object.fromEntries(AUTOMATION_CREDENTIAL_GROUPS.map((group) => [group.enabledKey, true])),
    ...settings,
  });
  host.credentials.write(Object.fromEntries(Object.entries(environment).filter(([key]) => !Object.hasOwn(settings, key))));
  return createAutomationRuntime({ ...provider, pgliteWorkflow: CHECK_PGLITE_RPC }, {
    ...host,
    userDataDirectory: resolve(options.userDataDirectory ?? "."),
    runExecution: (plan, run, round) => execute(
      plan,
      executions ? observingExecutions(run, executions) : run,
      assistanceRoute === undefined ? round : { ...round, assistanceRoute: assistanceRoute ?? undefined },
    ),
  });
}

/** Run one task to its end through the runtime's admission, queue and CAPTCHA Retry Campaign. */
export async function runForCheck(runtime: Pick<AutomationRuntime, "start">, taskId: string) {
  const { runId, settled } = await startForCheck(runtime, taskId);
  const run = await settled;
  if (!run) throw new Error(`${taskId} run ${runId} was not finalized`);
  return {
    taskRunId: runId,
    status: run.status,
    run,
    outcome: run.appWorkflowOutcome ?? { errorCode: null, summary: null } satisfies TypedWorkflowOutcome,
  };
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

/**
 * Where a check's worker gets its capability ports, `fixedCapabilities({})`
 * unless it names a source, and the definition and clock it runs with in
 * place of the catalog's and the wall clock.
 */
export type CheckWorkerPorts = Partial<Pick<AppWorkflowWorkerRuntimeOptions, "capabilities" | "resolveDefinition" | "now">>;

export type InProcessCheckHostOptions = CheckWorkerPorts & Readonly<{
  /** The browser a browser workflow's worker runs in, built from the page the round asked for. */
  browser?: (page: AppWorkflowBrowserHostInput) => WorkflowBrowserPort;
  /** Frames a check scripts in place of the real worker, given the start and the launch it came in. */
  scriptedWorker?: (start: AppWorkflowWorkerStart, launch: WorkerLaunch) => AppWorkflowWorkerHandle;
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
 * worker runtime in this process holding the check's capability source, or
 * the check's scripted worker. The launch's PGlite descriptor is not used; a
 * check that wants the child RPC passes `childRpcCapabilities` itself.
 */
export function inProcessCheckHost(options: InProcessCheckHostOptions = {}): ExecutionHost {
  const { browser, scriptedWorker, capabilities = fixedCapabilities({}), ...seams } = options;
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
    launchWorker(launch) {
      const { start } = launch;
      if (scriptedWorker) return scriptedWorker(start, launch);
      const page = pages.get(start.taskRunId);
      return inProcessWorker(start, { ...seams, capabilities, ...(page ? { browser: page } : {}) });
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
