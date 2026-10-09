import { randomUUID } from "node:crypto";
import { automationConfigEnv, type AutomationSettingsFile } from "./config-files.ts";
import {
  finalizeAutomationTaskRun,
  type AutomationTaskExecutionResult,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
import {
  type AutomationPersistencePort,
  isTerminalTaskRunStatus,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import type { AutomationTaskProgress } from "../types.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowExecutor } from "../workflow-executor.ts";
import type {
  WorkflowBrowserPort,
  WorkflowExecutorPorts,
  WorkflowProgressStatementType,
  WorkflowRunEvent,
} from "../workflow-executor.ts";
import {
  projectWorkflowRunProgress,
  selectedWorkflowStatementTypes,
} from "./workflow-run-progress.ts";
import { TYPED_WORKFLOW_ERROR_CODES as WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "../workflow-failures.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeInterruptedProductCollection,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";
import {
  appendWorkflowFailureDiagnostic,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
} from "./workflow-failure-diagnostics.ts";
import { createWorkflowFinancialCommitPort } from "../workflow-financial-commit.ts";
import {
  appWorkflowBrowserConnectionForSession,
  createAppWorkflowBrowserPort,
  type AppWorkflowBrowserConnection,
  type AppWorkflowBrowserProfile,
} from "./app-browser-host.ts";
import type { BrowserRuntimeIdentity } from "./browser-runtime.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import {
  runSupervisedAppWorkflow,
  type RunSupervisedAppWorkflowOptions,
} from "./app-workflow-worker-supervisor.ts";
import {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowBrowserProfileForTask,
  workflowRuntimeForTask,
  workflowStartUrlForTask,
  registerWorkflowHumanAssistanceForTask,
} from "./app-workflow-registry.ts";
import { createCathayGmailOtpPort } from "./cathay-otp-port.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
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
  /** This execution is another round of the same visible run. */
  retrying?: boolean;
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
    browserProfile?: AppWorkflowBrowserProfile;
    onRuntimeIdentity?: (identity: BrowserRuntimeIdentity) => void;
  }) => WorkflowBrowserPort;
};

function lastWorkflowStage(events: readonly WorkflowRunEvent[]): WorkflowRunEvent["stage"] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.stage !== "finalization") return events[index]?.stage;
  }
  return undefined;
}

function createWorkflowProgressReporter(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
  input: unknown,
) {
  let progress = execution.run.progress ?? indeterminateProgress(execution.run.attempt);
  const selectedStatementTypes = selectedWorkflowStatementTypes(input);
  let retrying = options.retrying === true;

  const persistProgress = async (next: AutomationTaskProgress): Promise<void> => {
    progress = next;
    try {
      const current = await execution.persistence.taskRunById(execution.run.taskRunId);
      if (current && !isTerminalTaskRunStatus(current.status)) {
        await execution.persistence.updateTaskRun(execution.run.taskRunId, { progress: next });
      }
    } catch {
      // Progress is advisory; a progress write must not turn a committed
      // workflow result into an ambiguous failure.
    }
  };

  const refreshRuntime = async (): Promise<void> => {
    try {
      await execution.onRuntimeUpdate?.(execution.run.taskRunId);
    } catch {
      // The persisted event and progress record are authoritative.
    }
  };

  return {
    async appendEvent(event: WorkflowRunEvent): Promise<void> {
      const authenticationSucceeded = event.stage === "authentication"
        && /authentication-(?:completed|verified|success)$/u.test(event.code);
      const retryIsCaughtUp = authenticationSucceeded || event.stage === "collection";
      const recordedEvent = retrying && !retryIsCaughtUp
        ? { ...event, retrying: true }
        : event;
      if (retryIsCaughtUp) retrying = false;

      await execution.persistence.appendRunEvent(recordedEvent);
      const projected = projectWorkflowRunProgress(
        recordedEvent,
        progress,
        selectedStatementTypes,
      );
      if (projected) await persistProgress(projected);
      await refreshRuntime();
    },

    async appendExchangeRateProgress(value: Readonly<{
      phaseCode: "load-request" | "sync" | "complete";
      completed: number;
      total: number;
      percent: number;
    }>): Promise<void> {
      const percent = Math.max(progress.percent ?? 0, Math.min(99, Math.max(0, value.percent)));
      await persistProgress({ ...value, percent, attempt: execution.run.attempt });
      await refreshRuntime();
    },
  };
}

async function recordWorkflowFailure(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
  input: Readonly<{
    source: "workflow-worker" | "workflow-host";
    errorCode: string;
    stage?: WorkflowRunEvent["stage"];
    statementType?: WorkflowProgressStatementType;
    error?: unknown;
    safeError?: unknown;
  }>,
): Promise<void> {
  const workflowId = execution.task.workflowId;
  if (!workflowId) return;
  const launchEnv = options.launchEnv ?? automationProcessEnv();
  await appendWorkflowFailureDiagnostic(launchEnv[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
    workflowId,
    taskRunId: execution.run.taskRunId,
    ...input,
  }, { repoRoot: workflowFailureDiagnosticRepoRoot(launchEnv) });
}

type BrowserRuntimeIdentityRecorder = Readonly<{
  record(identity: BrowserRuntimeIdentity): void;
  flush(): Promise<void>;
}>;

function createBrowserRuntimeIdentityRecorder(
  execution: AutomationTaskRunExecution,
): BrowserRuntimeIdentityRecorder {
  let pendingWrite: Promise<void> | undefined;
  let writeFailed = false;
  return {
    record(identity) {
      pendingWrite = execution.persistence.updateTaskRun(execution.run.taskRunId, {
        browserRuntime: {
          profileId: identity.profileId,
          profileRevision: identity.profileRevision,
          chromiumVersion: identity.chromiumVersion,
        },
      }).catch(() => {
        writeFailed = true;
      });
    },
    async flush() {
      await pendingWrite;
      if (writeFailed) throw new Error("Browser runtime identity persistence failed.");
    },
  };
}

function browserPortWithIdentityPersistence(
  browser: WorkflowBrowserPort,
  recorder: BrowserRuntimeIdentityRecorder,
): WorkflowBrowserPort {
  return {
    async withPage(run) {
      return await browser.withPage(async (page) => {
        // The host reports identity before launch. Persist it before the
        // workflow worker or inline provider can touch the source.
        await recorder.flush();
        return await run(page);
      });
    },
  };
}

async function executeAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskExecutionResult> {
  // Explicit port overrides are an inline composition seam. Production browser
  // workflows, including E-Invoice, use the supervised App worker.
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
  let workflowOutput: unknown;
  const browserRuntimeIdentity = createBrowserRuntimeIdentityRecorder(execution);
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    if (options.isCancellationRequested?.()) {
      controller.abort(new Error("Automation task cancelled."));
    }
    const injectedPorts = options.workflowPorts ?? {};
    let financialCommit = injectedPorts.financialCommit;
    if (definition.requiresFinancialCommit && !financialCommit) {
      childRpc = requirePGliteChildRpcClientFromEnv(launchEnv, {
        workflowId: execution.task.workflowId,
        taskRunId: execution.run.taskRunId,
      });
      await childRpc.ready;
      financialCommit = createWorkflowFinancialCommitPort(childRpc.workflow);
    }
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const input = workflowInputForTask(execution.task.workflowId, launchEnv);
    const progressReporter = createWorkflowProgressReporter(execution, options, input);
    const startUrl = workflowStartUrlForTask(execution.task.workflowId);
    const browserProfile = workflowBrowserProfileForTask(execution.task.workflowId);
    const browser: WorkflowBrowserPort = injectedPorts.browser
      ?? options.workflowBrowserPortFactory?.({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
        browserProfile,
        onRuntimeIdentity: browserRuntimeIdentity.record,
      })
      ?? createAppWorkflowBrowserPort({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
        browserProfile,
        onRuntimeIdentity: browserRuntimeIdentity.record,
      });
    const browserWithIdentityPersistence = browserPortWithIdentityPersistence(
      browser,
      browserRuntimeIdentity,
    );
    const ports: WorkflowExecutorPorts = {
      browser: browserWithIdentityPersistence,
      text: strictSourceText,
      humanAssistance: injectedPorts.humanAssistance
        ?? createAppWorkflowHumanAssistancePort({
          taskRunId: execution.run.taskRunId,
          persistence: execution.persistence,
          onRuntimeUpdate: execution.onRuntimeUpdate,
        }),
      ...(financialCommit ? { financialCommit } : {}),
      events: injectedPorts.events ?? {
        async append(event) {
          await progressReporter.appendEvent(event);
        },
      },
      now: injectedPorts.now ?? (() => new Date().toISOString()),
      onEventFailure: injectedPorts.onEventFailure
        ?? (() => console.error("workflow-event-persistence-failed")),
      productFailure: (failure) => recordWorkflowFailure(execution, options, {
        source: "workflow-host",
        errorCode: failure.errorCode,
        stage: failure.stage,
        statementType: failure.statementType,
        error: failure.error,
      }),
    };
    const executor = createWorkflowExecutor([definition], ports);
    if (!options.verificationRouteOwnedByCampaign) {
      unregisterHumanAssistance = await registerWorkflowHumanAssistanceForTask(
        execution.task.workflowId,
        { automation: execution.persistence },
      );
    }
    workflowOutput = await executor.run(
      execution.task.workflowId,
      execution.run.taskRunId,
      input,
      controller.signal,
    );
    await browserRuntimeIdentity.flush();
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
    try {
      await browserRuntimeIdentity.flush();
    } catch {
      // Preserve only a stable workflow failure; persistence errors are opaque.
    }
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
        summary: summarizeInterruptedProductCollection(error)
          ?? summarizeTypedWorkflowOutput(workflowOutput),
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
    if (!cancelled) {
      await recordWorkflowFailure(execution, options, {
        source: "workflow-host",
        errorCode: result.appWorkflowOutcome?.errorCode ?? "workflow-failed",
        stage: lastWorkflowStage(events),
        error,
      });
    }
  } finally {
    unregisterHumanAssistance?.();
    clearInterval(cancellationPoll);
    activeWorkflowControllers.delete(execution.task.id);
    activeWorkflowRunIds.delete(execution.task.id);
    childRpc?.close();
  }
  return result;
}

const TYPED_WORKFLOW_ERROR_CODES = new Set<TypedWorkflowErrorCode>(WORKFLOW_ERROR_CODES);

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
      appWorkflowOutcome: { errorCode: "cancelled", summary: outcome.summary },
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
      appWorkflowOutcome: { errorCode: "cancelled", summary: outcome.summary },
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
    appWorkflowOutcome: { errorCode, summary: outcome.summary },
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
  let workerOutcome: Awaited<ReturnType<typeof runSupervisedAppWorkflow>> | undefined;
  const observedEvents: WorkflowRunEvent[] = [];
  let priorEventCount: number | null = null;
  const browserRuntimeIdentity = createBrowserRuntimeIdentityRecorder(execution);
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
    const progressReporter = createWorkflowProgressReporter(execution, options, input);
    const runtime = workflowRuntimeForTask(workflowId);
    const pgliteRpc = (definition.requiresFinancialCommit || runtime.kind === "nonbrowser")
      ? pgliteRpcForWorker(launchEnv)
      : undefined;
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const browser = runtime.kind === "nonbrowser" ? undefined : options.workflowBrowserPortFactory?.({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal: controller.signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
    }) ?? createAppWorkflowBrowserPort({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal: controller.signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
      nativeDialogOwner: "worker",
    });
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      taskRunId: execution.run.taskRunId,
      persistence: execution.persistence,
      onRuntimeUpdate: execution.onRuntimeUpdate,
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
          await progressReporter.appendEvent(event);
        },
        ...(workflowId === "exchange-rates" ? {
          appendExchangeRateProgress: async (progress: Readonly<{
            phaseCode: "load-request" | "sync" | "complete";
            completed: number;
            total: number;
            percent: number;
          }>) => {
            await progressReporter.appendExchangeRateProgress(progress);
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
        await browserRuntimeIdentity.flush();
        const browserConnection = (options.appWorkflowBrowserConnectionForRun
          ?? appWorkflowBrowserConnectionForSession)(execution.run.taskRunId);
        if (!browserConnection) {
          throw new Error("The App browser worker connection is unavailable for this active run.");
        }
        return await runWorker(browserConnection);
      })
      : await runWorker();
    workerOutcome = outcome;
    await browserRuntimeIdentity.flush();

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
      // A structured product failure is explicit evidence, even when its code
      // is workflow-failed. Do not replace it with a guess from the last event.
      const productConfirmsCode = outcome.summary?.products?.some(
        (product) => product.status === "failed" && product.errorCode === explicitCode,
      );
      const errorCode = explicitCode && (explicitCode !== "workflow-failed" || productConfirmsCode)
        ? explicitCode
        : classifyTypedWorkflowFailure(
            new Error("App workflow worker failed."),
            eventsForExecution,
            outcome.status === "cancelled",
          );
      result = sanitizedWorkerResult(outcome, errorCode);
      if (outcome.status === "failed") {
        await recordWorkflowFailure(execution, options, {
          source: "workflow-worker",
          errorCode,
          stage: lastWorkflowStage(eventsForExecution),
          safeError: outcome.diagnostic,
        });
      }
    }
  } catch (error) {
    try {
      await browserRuntimeIdentity.flush();
    } catch {
      // Preserve only a stable workflow failure; persistence errors are opaque.
    }
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
      error,
      eventsForExecution,
      cancelled,
    );
    result = sanitizedWorkerResult(
      cancelled ? {
        status: "cancelled",
        errorCode: "cancelled",
        summary: summarizeInterruptedProductCollection(error) ?? workerOutcome?.summary ?? null,
      } : {
        status: "failed",
        errorCode: "workflow-failed",
        summary: summarizeInterruptedProductCollection(error) ?? workerOutcome?.summary ?? null,
        failureKind: "worker-crash",
      },
      errorCode,
    );
    if (!cancelled) {
      await recordWorkflowFailure(execution, options, {
        source: "workflow-host",
        errorCode,
        stage: lastWorkflowStage(eventsForExecution),
        error,
      });
    }
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
  const startingProgress = existingRun?.progress
    ? { ...existingRun.progress, attempt }
    : indeterminateProgress(attempt);
  const run = existingRun
    ? { taskRunId: existingRun.taskRunId, attempt, progress: startingProgress }
    : {
        ...(await persistence.createTaskRun({
          taskId: task.id,
          kind: task.kind,
          status: "running",
          attempt,
          maxAttempts,
          startedAt,
          scheduledAtUtc: options.scheduledAtUtc,
          progress: startingProgress,
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
      progress: startingProgress,
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
    percent: 0,
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
  const nonbrowserLaunchEnv = workflowRuntimeForTask(task.workflowId).kind === "nonbrowser"
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
    try {
      await execution.onRuntimeUpdate?.(execution.run.taskRunId);
    } catch {
      // Runtime refresh follows the terminal persistence boundary.
    }
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
    try {
      await execution.onRuntimeUpdate?.(execution.run.taskRunId);
    } catch {
      // Runtime refresh follows the terminal persistence boundary.
    }
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
