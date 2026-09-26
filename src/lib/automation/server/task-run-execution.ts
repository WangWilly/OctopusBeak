import { randomUUID } from "node:crypto";
import { automationConfigEnv, type AutomationSettingsFile } from "./config-files.ts";
import {
  finalizeAutomationTaskRun,
  type AutomationTaskExecutionResult,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
import {
  type AutomationPersistencePort,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import { automationGroupVerificationActors } from "./settings.ts";
import type { AutomationTaskProgress } from "../types.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowExecutor } from "../workflow-executor.ts";
import type {
  WorkflowBrowserPort,
  WorkflowExecutorPorts,
  WorkflowRunEvent,
} from "../workflow-executor.ts";
import type { TypedWorkflowErrorCode } from "./typed-workflow-outcome.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";
import { createWorkflowFinancialCommitPort } from "../workflow-financial-commit.ts";
import {
  appWorkflowBrowserConnectionForSession,
  createAppWorkflowBrowserPort,
  type AppWorkflowBrowserConnection,
} from "./app-browser-host.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import {
  runSupervisedAppWorkflow,
  type RunSupervisedAppWorkflowOptions,
} from "./app-workflow-worker-supervisor.ts";
import {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
  registerWorkflowHumanAssistanceForTask,
} from "./app-workflow-registry.ts";
import { createCathayGmailOtpPort } from "./cathay-otp-port.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
  createPGliteChildRpcClient,
  requirePGliteChildRpcClientFromEnv,
} from "../../../../electron/pglite-child-rpc-client.ts";

const activeWorkflowControllers = new Map<string, AbortController>();
const activeWorkflowRunIds = new Map<string, string>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  /** Reuse the user-visible task run for an internal execution. */
  taskRunId?: string;
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  launchVerificationSettings?: AutomationSettingsFile;
  /** The surrounding CAPTCHA campaign installs this task's App route. */
  verificationRouteOwnedByCampaign?: boolean;
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Let a higher-level campaign own the single terminal transition. */
  deferFinalization?: boolean;
  /** Stop a typed workflow when the host task was cancelled. */
  isCancellationRequested?: () => boolean;
  isForceTerminationRequested?: () => boolean;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
  /** App composition may replace a typed workflow capability at its port seam. */
  workflowPorts?: Partial<WorkflowExecutorPorts>;
  /** Test seam for exercising the main-only Cathay Gmail OTP dependency. */
  createCathayGmailOtpPort?: typeof createCathayGmailOtpPort;
  /** Test seam for the supervised App workflow worker. Production uses Worker. */
  appWorkflowWorkerFactory?: RunSupervisedAppWorkflowOptions["workerFactory"];
  /** Test seam for proving that the worker receives the active host descriptor. */
  appWorkflowBrowserConnectionForRun?: (
    taskRunId: string,
  ) => AppWorkflowBrowserConnection | null;
  workflowBrowserPortFactory?: (input: {
    taskId: string;
    taskRunId: string;
    signal: AbortSignal;
    userDataDirectory: string;
    startUrl?: string;
  }) => WorkflowBrowserPort;
};

function requiresSolverRoute(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
) {
  const groupId = execution.task.credentialGroupId;
  return groupId !== undefined
    && automationGroupVerificationActors(options.launchVerificationSettings)[groupId] === "solver";
}

async function executeAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskExecutionResult> {
  // Provider fixtures still inject executor ports to exercise each workflow
  // without a worker. Production supplies none and always uses the supervisor.
  if (options.workflowPorts !== undefined) {
    return await executeInlineAppWorkflow(execution, options);
  }
  return await executeSupervisedAppWorkflow(execution, options);
}

async function executeInlineAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskExecutionResult> {
  const workflowDependencies = execution.task.workflowId === "cathay-all-statements"
    ? {
      cathayGmailOtpPort: (options.createCathayGmailOtpPort ?? createCathayGmailOtpPort)(),
    }
    : {};
  const definition = workflowDefinitionForTask(execution.task.workflowId, workflowDependencies);
  if (!definition || !execution.task.workflowId) {
    return {
      exitCode: 1,
      signal: null,
      error: new Error("App workflow definition is unavailable."),
      statementSummary: null,
      appWorkflowOutcome: { errorCode: "workflow-failed", summary: null },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  }

  const controller = new AbortController();
  const cancellationPoll = setInterval(() => {
    if (options.isCancellationRequested?.() && !controller.signal.aborted) {
      controller.abort(new Error("Automation task cancelled."));
    }
  }, 50);
  cancellationPoll.unref();
  activeWorkflowControllers.set(execution.task.id, controller);
  activeWorkflowRunIds.set(execution.task.id, execution.run.taskRunId);

  let childRpc: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  let unregisterHumanAssistance: (() => void) | undefined;
  let result: AutomationTaskExecutionResult;
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    if (options.isCancellationRequested?.()) {
      controller.abort(new Error("Automation task cancelled."));
    }
    const injectedPorts = options.workflowPorts ?? {};
    let financialCommit = injectedPorts.financialCommit;
    if (definition.requiresFinancialCommit && !financialCommit) {
      childRpc = requirePGliteChildRpcClientFromEnv(launchEnv);
      await childRpc.ready;
      financialCommit = createWorkflowFinancialCommitPort(childRpc.workflow);
    }
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const startUrl = workflowStartUrlForTask(execution.task.workflowId);
    const browser = injectedPorts.browser
      ?? options.workflowBrowserPortFactory?.({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
      })
      ?? createAppWorkflowBrowserPort({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
      });
    const ports: WorkflowExecutorPorts = {
      browser,
      text: strictSourceText,
      humanAssistance: injectedPorts.humanAssistance
        ?? createAppWorkflowHumanAssistancePort({
          taskRunId: execution.run.taskRunId,
          persistence: execution.persistence,
          onRuntimeUpdate: execution.onRuntimeUpdate,
          requireSolverRoute: requiresSolverRoute(execution, options),
        }),
      ...(financialCommit ? { financialCommit } : {}),
      events: injectedPorts.events ?? {
        async append(event) {
          await execution.persistence.appendRunEvent(event);
          await execution.onRuntimeUpdate?.(event.runId);
        },
      },
      now: injectedPorts.now ?? (() => new Date().toISOString()),
      onEventFailure: injectedPorts.onEventFailure
        ?? (() => console.error("workflow-event-persistence-failed")),
    };
    const executor = createWorkflowExecutor([definition], ports);
    if (!options.verificationRouteOwnedByCampaign) {
      unregisterHumanAssistance = await registerWorkflowHumanAssistanceForTask(
        execution.task.workflowId,
        { automation: execution.persistence },
      );
    }
    const workflowOutput = await executor.run(
      execution.task.workflowId,
      execution.run.taskRunId,
      workflowInputForTask(execution.task.workflowId, launchEnv),
      controller.signal,
    );
    result = {
      exitCode: 0,
      signal: null,
      error: null,
      statementSummary: null,
      appWorkflowOutcome: {
        errorCode: null,
        summary: summarizeTypedWorkflowOutput(workflowOutput),
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  } catch (error) {
    const cancelled = controller.signal.aborted
      || options.isCancellationRequested?.() === true;
    let events: readonly WorkflowRunEvent[] = [];
    try {
      events = (await execution.persistence.taskRunById(execution.run.taskRunId))?.events ?? [];
    } catch {
      // Classification falls back to the opaque workflow code if events are unavailable.
    }
    result = {
      exitCode: cancelled ? null : 1,
      signal: cancelled ? "SIGTERM" : null,
      // Provider exceptions may contain account or invoice data. Persist only
      // a stable task-level classification in the operational database.
      error: cancelled
        ? new Error("Automation task cancelled.")
        : new Error("App workflow failed (workflow-failed)."),
      statementSummary: null,
      appWorkflowOutcome: {
        errorCode: classifyTypedWorkflowFailure(error, events, cancelled),
        summary: null,
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  } finally {
    unregisterHumanAssistance?.();
    clearInterval(cancellationPoll);
    activeWorkflowControllers.delete(execution.task.id);
    activeWorkflowRunIds.delete(execution.task.id);
    childRpc?.close();
  }
  return result;
}

const TYPED_WORKFLOW_ERROR_CODES = new Set<TypedWorkflowErrorCode>([
  "cancelled",
  "source-integrity-failed",
  "source-validation-failed",
  "source-access-challenged",
  "verification-configuration-failed",
  "canonical-commit-failed",
  "commit-outcome-unknown",
  "workflow-failed",
]);

function typedWorkerFailureCode(code: string): TypedWorkflowErrorCode | null {
  return TYPED_WORKFLOW_ERROR_CODES.has(code as TypedWorkflowErrorCode)
    ? code as TypedWorkflowErrorCode
    : null;
}

function pgliteRpcForWorker(environment: NodeJS.ProcessEnv) {
  const endpoint = environment[PGLITE_CHILD_RPC_ENDPOINT_ENV]?.trim();
  const token = environment[PGLITE_CHILD_RPC_TOKEN_ENV]?.trim();
  if (!endpoint || !token) {
    throw new Error("PGlite workflow transport is unavailable.");
  }
  return { endpoint, token };
}

function sanitizedWorkerResult(
  outcome: Awaited<ReturnType<typeof runSupervisedAppWorkflow>>,
  errorCode: TypedWorkflowErrorCode,
): AutomationTaskExecutionResult {
  if (outcome.status === "completed" && errorCode === "cancelled") {
    return {
      exitCode: null,
      signal: "SIGTERM",
      error: new Error("Automation task cancelled."),
      statementSummary: null,
      appWorkflowOutcome: { errorCode: "cancelled", summary: null },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  }
  if (outcome.status === "completed") {
    return {
      exitCode: 0,
      signal: null,
      error: null,
      statementSummary: null,
      appWorkflowOutcome: {
        errorCode: null,
        summary: outcome.summary,
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  }

  if (errorCode === "cancelled") {
    return {
      exitCode: null,
      signal: "SIGTERM",
      error: new Error("Automation task cancelled."),
      statementSummary: null,
      appWorkflowOutcome: { errorCode: "cancelled", summary: null },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  }

  return {
    // An ambiguous commit must remain a failure through finalization. Marking
    // it cancelled would hide the uncertain financial outcome from the App.
    exitCode: 1,
    signal: null,
    error: new Error(`App workflow failed (${errorCode}).`),
    statementSummary: null,
    appWorkflowOutcome: { errorCode, summary: null },
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
  };
}

async function executeSupervisedAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskExecutionResult> {
  const workflowId = execution.task.workflowId;
  const definition = workflowDefinitionForTask(workflowId);
  if (!definition || !workflowId || definition.id !== workflowId) {
    return sanitizedWorkerResult({
      status: "failed",
      errorCode: "worker-start-failed",
      summary: null,
      failureKind: "worker-start",
    }, "workflow-failed");
  }

  const controller = new AbortController();
  const cancellationPoll = setInterval(() => {
    if (
      (options.isCancellationRequested?.() || options.isForceTerminationRequested?.())
      && !controller.signal.aborted
    ) {
      controller.abort(new Error("Automation task cancelled."));
    }
  }, 50);
  cancellationPoll.unref();
  activeWorkflowControllers.set(execution.task.id, controller);
  activeWorkflowRunIds.set(execution.task.id, execution.run.taskRunId);

  let unregisterHumanAssistance: (() => void) | undefined;
  let result: AutomationTaskExecutionResult;
  const observedEvents: WorkflowRunEvent[] = [];
  let priorEventCount: number | null = null;
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    if (options.isCancellationRequested?.() || options.isForceTerminationRequested?.()) {
      controller.abort(new Error("Automation task cancelled."));
    }
    try {
      const existing = await execution.persistence.taskRunById(execution.run.taskRunId);
      priorEventCount = existing?.events.length ?? null;
    } catch {
      // Worker events are also observed in memory before persistence is ACKed.
    }

    const input = workflowInputForTask(workflowId, launchEnv);
    const nonbrowser = workflowId === "exchange-rates" || workflowId === "sync-maicoin";
    const pgliteRpc = (definition.requiresFinancialCommit || workflowId === "exchange-rates")
      ? pgliteRpcForWorker(launchEnv)
      : undefined;
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const startUrl = workflowStartUrlForTask(workflowId);
    const browser = nonbrowser ? undefined : options.workflowBrowserPortFactory?.({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal: controller.signal,
      userDataDirectory,
      startUrl,
    }) ?? (nonbrowser ? undefined : createAppWorkflowBrowserPort({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal: controller.signal,
      userDataDirectory,
      startUrl,
    }));
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      taskRunId: execution.run.taskRunId,
      persistence: execution.persistence,
      onRuntimeUpdate: execution.onRuntimeUpdate,
      requireSolverRoute: requiresSolverRoute(execution, options),
    });
    if (!options.verificationRouteOwnedByCampaign) {
      unregisterHumanAssistance = await registerWorkflowHumanAssistanceForTask(
        workflowId,
        { automation: execution.persistence },
      );
    }

    const runWorker = async (browserConnection?: AppWorkflowBrowserConnection) => {
      controller.signal.throwIfAborted();
      return await runSupervisedAppWorkflow({
        runId: execution.run.taskRunId,
        workflowId,
        input,
        ...(browserConnection ? { browserConnection } : {}),
        ...(pgliteRpc ? { pgliteRpc } : {}),
        signal: controller.signal,
        appendEvent: async (event) => {
          // The supervisor ACKs only after this callback completes. Record the
          // attempted event first so commit ambiguity remains detectable even
          // if persistence fails and the worker later crashes.
          observedEvents.push(event);
          await execution.persistence.appendRunEvent(event);
          try {
            await execution.onRuntimeUpdate?.(event.runId);
          } catch {
            // Runtime refresh is secondary to the persisted event and must not
            // turn an ACKed database write into a worker failure.
          }
        },
        ...(workflowId === "exchange-rates" ? {
          appendExchangeRateProgress: async (progress: Readonly<{
            phaseCode: "load-request" | "sync" | "complete";
            completed: number;
            total: number;
            percent: number;
          }>) => {
            await execution.persistence.updateTaskRun(execution.run.taskRunId, {
              progress: { ...progress, attempt: execution.run.attempt },
            });
            await execution.onRuntimeUpdate?.(execution.run.taskRunId);
          },
        } : {}),
        requestHumanAssistance: (contract, signal) =>
          humanAssistance.request(contract, signal),
        ...(options.createCathayGmailOtpPort
          ? {
              createCathayGmailOtpPort: (signal) =>
                options.createCathayGmailOtpPort!(undefined, { signal }),
            }
          : {}),
        ...(options.appWorkflowWorkerFactory
          ? { workerFactory: options.appWorkflowWorkerFactory }
          : {}),
      });
    };
    const outcome = browser
      ? await browser.withPage(async () => {
        const browserConnection = (options.appWorkflowBrowserConnectionForRun
          ?? appWorkflowBrowserConnectionForSession)(execution.run.taskRunId);
        if (!browserConnection) {
          throw new Error("The App browser worker connection is unavailable for this active run.");
        }
        return await runWorker(browserConnection);
      })
      : await runWorker();

    let eventsForExecution = observedEvents;
    try {
      const persisted = await execution.persistence.taskRunById(execution.run.taskRunId);
      if (persisted) {
        eventsForExecution = priorEventCount === null
          ? [...observedEvents]
          : [...persisted.events.slice(priorEventCount), ...observedEvents];
      }
    } catch {
      // Each worker action is ordered behind a main-thread event ACK, so the
      // observed event list remains an authoritative boundary on commit entry.
    }

    if (outcome.status === "completed") {
      result = sanitizedWorkerResult(outcome, "workflow-failed");
    } else {
      const explicitCode = outcome.status === "failed"
        ? typedWorkerFailureCode(outcome.errorCode)
        : null;
      const errorCode = explicitCode && explicitCode !== "workflow-failed"
        ? explicitCode
        : classifyTypedWorkflowFailure(
            new Error("App workflow worker failed."),
            eventsForExecution,
            outcome.status === "cancelled",
          );
      result = sanitizedWorkerResult(outcome, errorCode);
    }
  } catch {
    const cancelled = controller.signal.aborted
      || options.isCancellationRequested?.() === true
      || options.isForceTerminationRequested?.() === true;
    let eventsForExecution: readonly WorkflowRunEvent[] = observedEvents;
    try {
      const persisted = await execution.persistence.taskRunById(execution.run.taskRunId);
      if (persisted) {
        eventsForExecution = [
          ...(priorEventCount === null ? [] : persisted.events.slice(priorEventCount)),
          ...observedEvents,
        ];
      }
    } catch {
      // Do not include provider error text in the task outcome.
    }
    const errorCode = classifyTypedWorkflowFailure(
      new Error("App workflow worker failed."),
      eventsForExecution,
      cancelled,
    );
    result = sanitizedWorkerResult(
      cancelled ? { status: "cancelled", errorCode: "cancelled", summary: null } : {
        status: "failed",
        errorCode: "workflow-failed",
        summary: null,
        failureKind: "worker-crash",
      },
      errorCode,
    );
  } finally {
    unregisterHumanAssistance?.();
    clearInterval(cancellationPoll);
    activeWorkflowControllers.delete(execution.task.id);
    activeWorkflowRunIds.delete(execution.task.id);
  }
  return result!;
}

export function automationProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  return automationConfigEnv({ baseEnv });
}

async function createAutomationTaskRunExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskRunExecution | null> {
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 1;
  const startedAt = new Date().toISOString();
  const existingRun = options.taskRunId
    ? await persistence.taskRunById(options.taskRunId)
    : null;
  if (options.taskRunId && !existingRun) return null;
  const run = existingRun
    ? { taskRunId: existingRun.taskRunId, attempt }
    : {
        ...(await persistence.createTaskRun({
          taskId: task.id,
          kind: task.kind,
          status: "running",
          attempt,
          maxAttempts,
          startedAt,
          scheduledAtUtc: options.scheduledAtUtc,
          progress: indeterminateProgress(attempt),
        })),
        attempt,
      };
  if (existingRun) {
    await persistence.updateTaskRun(existingRun.taskRunId, {
      status: "running",
      attempt,
      maxAttempts,
      finishedAt: null,
      exitCode: null,
      signal: null,
      progress: indeterminateProgress(attempt),
    });
  }
  return {
    task,
    persistence,
    run,
    executionId: options.executionId ?? randomUUID(),
    onRuntimeUpdate: options.onRuntimeUpdate,
  };
}

function indeterminateProgress(attempt: number): AutomationTaskProgress {
  return {
    phaseCode: null,
    completed: null,
    total: null,
    percent: null,
    attempt,
  };
}

export async function runAutomationTaskExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions,
  onRunCreated: (taskRunId: string) => void | Promise<void>,
) {
  if (options.isCancellationRequested?.()) {
    return { status: "cancelled" as const };
  }
  if (!task.workflowId) {
    throw new Error("App workflow definition is unavailable.");
  }
  const nonbrowserLaunchEnv = task.id === "sync-maicoin" || task.id === "exchange-rates"
    ? options.launchEnv ?? automationProcessEnv()
    : undefined;
  if (nonbrowserLaunchEnv
    && (!nonbrowserLaunchEnv[PGLITE_CHILD_RPC_ENDPOINT_ENV]?.trim()
      || !nonbrowserLaunchEnv[PGLITE_CHILD_RPC_TOKEN_ENV]?.trim())) {
    throw new Error("PGlite workflow transport is unavailable.");
  }
  const execution = await createAutomationTaskRunExecution(
    task,
    persistence,
    options,
  );
  if (!execution) {
    return { status: "failed" as const };
  }
  await onRunCreated(execution.run.taskRunId);
  if (options.isCancellationRequested?.()) {
    const cancelledResult: AutomationTaskExecutionResult = {
      exitCode: null,
      signal: "SIGTERM",
      error: new Error("Automation task cancelled."),
      statementSummary: null,
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
    if (options.deferFinalization) {
      return {
        status: "cancelled" as const,
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        result: cancelledResult,
      };
    }
    const finalized = await finalizeAutomationTaskRun(
      {
        provider: { automation: persistence },
        taskId: task.id,
        taskKind: task.kind,
        taskRunId: execution.run.taskRunId,
      },
      cancelledResult,
    );
    return {
      status: finalized.status,
      taskRunId: execution.run.taskRunId,
      executionId: execution.executionId,
    };
  }
  if (task.workflowId) {
    const result = await executeAppWorkflow(execution, options);
    const provider = { automation: persistence };
    if (options.deferFinalization) {
      return {
        status: automationTaskExecutionStatus(result, {
          forceTerminated: options.isForceTerminationRequested?.() === true,
        }),
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        result,
      };
    }
    const finalized = await finalizeAutomationTaskRun(
      {
        provider,
        taskId: task.id,
        taskKind: task.kind,
        taskRunId: execution.run.taskRunId,
        forceTerminated: options.isForceTerminationRequested?.() === true,
      },
      result,
    );
    return {
      status: finalized.status,
      taskRunId: execution.run.taskRunId,
      executionId: execution.executionId,
      result,
    };
  }
  throw new Error("App workflow definition is unavailable.");
}

export function automationTaskExecutionStatus(
  result: AutomationTaskExecutionResult,
  options: {
    forceTerminated?: boolean;
  } = {},
) {
  const cancelled = options.forceTerminated === true
    || result.signal === "SIGTERM"
    || result.error?.message === "Automation task cancelled."
    || result.appWorkflowOutcome?.errorCode === "cancelled";
  if (cancelled) return "cancelled" as const;
  if (result.error || result.appWorkflowOutcome?.errorCode) return "failed" as const;
  const summaryStatus = result.appWorkflowOutcome?.summary?.status
    ?? result.statementSummary?.status;
  if (summaryStatus === "partial") return "partial" as const;
  if (summaryStatus === "failed") return "failed" as const;
  return result.exitCode === 0 ? "completed" as const : "failed" as const;
}

/** Abort live App workflows and persist interruption before startup recovery. */
export async function interruptActiveAppWorkflows(
  persistence: AutomationPersistencePort,
) {
  for (const [taskId, taskRunId] of activeWorkflowRunIds) {
    const controller = activeWorkflowControllers.get(taskId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("App is shutting down."));
    }
    const current = await persistence.taskRunById(taskRunId);
    if (!current || !["preparing", "queued", "running", "retrying", "cancelling", "waiting_for_human"].includes(current.status)) {
      continue;
    }
    await persistence.transitionTaskRunToTerminal(taskRunId, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      appWorkflowOutcome: current.appWorkflowOutcome ?? {
        errorCode: "cancelled",
        summary: null,
      },
    });
  }
}

export function abortActiveAppWorkflowExecutions() {
  for (const controller of activeWorkflowControllers.values()) {
    if (!controller.signal.aborted) controller.abort(new Error("App is shutting down."));
  }
}
