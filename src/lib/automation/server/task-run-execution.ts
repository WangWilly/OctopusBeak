import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREDENTIALS_PATH,
  automationConfigEnv,
  getAutomationCredentialCodec,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost, type TdccSessionHost } from "./tdcc-session-host.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { taskById } from "./tasks.ts";
import { registerCollectionScope } from "./collection-scope.ts";
import type { AutomationTaskProgress } from "../types.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowExecutor, workflowUsesPreviewWrite } from "../workflow-executor.ts";
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
  type TypedWorkflowOutcome,
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
import { previewStructureReports, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
  requirePGliteChildRpcClientFromEnv,
} from "../../../../electron/pglite-child-rpc-client.ts";

/** One workflow execution within an Active Automation Task Run. */
type AutomationTaskRunExecution = Readonly<{
  task: NonNullable<ReturnType<typeof taskById>>;
  run: ActiveAutomationTaskRun;
  executionId: string;
}>;

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
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
  /** App composition may replace a typed workflow capability at its port seam. */
  workflowPorts?: Partial<WorkflowExecutorPorts>;
  /** Test seam for the host side of a TDCC run's session port. Production reads credentials.json. */
  createTdccSessionHost?: () => TdccSessionHost;
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
  let progress = execution.run.current().progress ?? indeterminateProgress(execution.run.current().attempt);
  const selectedStatementTypes = selectedWorkflowStatementTypes(input);
  let retrying = options.retrying === true;

  const persistProgress = async (next: AutomationTaskProgress): Promise<void> => {
    progress = next;
    try {
      await execution.run.update({ progress: next });
    } catch {
      // Progress is advisory; a progress write must not turn a committed
      // workflow result into an ambiguous failure.
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

      await execution.run.persistence.appendRunEvent(recordedEvent);
      const projected = projectWorkflowRunProgress(
        recordedEvent,
        progress,
        selectedStatementTypes,
      );
      if (projected) await persistProgress(projected);
    },

    async appendExchangeRateProgress(value: Readonly<{
      phaseCode: "load-request" | "sync" | "complete";
      completed: number;
      total: number;
      percent: number;
    }>): Promise<void> {
      const percent = Math.max(progress.percent ?? 0, Math.min(99, Math.max(0, value.percent)));
      await persistProgress({ ...value, percent, attempt: execution.run.current().attempt });
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
      pendingWrite = execution.run.persistence.updateTaskRun(execution.run.taskRunId, {
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
): Promise<TypedWorkflowOutcome> {
  const scope = registerCollectionScope(
    execution.run.taskRunId,
    execution.task,
    options.launchEnv ?? automationProcessEnv(),
  );
  try {
    // Explicit port overrides are an inline composition seam. Production browser
    // workflows, including E-Invoice, use the supervised App worker.
    const result = options.workflowPorts !== undefined
      ? await executeInlineAppWorkflow(execution, options)
      : await executeSupervisedAppWorkflow(execution, options);
    return scope.refused() ? collectionScopeChangedResult(result) : result;
  } finally {
    scope.release();
  }
}

function collectionScopeChangedResult(
  result: TypedWorkflowOutcome,
): TypedWorkflowOutcome {
  const { summary } = result;
  return {
    errorCode: "collection-scope-changed",
    summary: summary?.products
      ? {
        ...summary,
        products: summary.products.map((product) =>
          product.errorCode === "commit-outcome-unknown"
            ? { ...product, errorCode: "collection-scope-changed" }
            : product),
      }
      : summary,
  };
}

async function executeInlineAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<TypedWorkflowOutcome> {
  const definition = workflowDefinitionForTask(execution.task.workflowId);
  if (!definition || !execution.task.workflowId) {
    return { errorCode: "workflow-failed", summary: null };
  }

  const { signal } = execution.run;
  let childRpc: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  let unregisterHumanAssistance: (() => void) | undefined;
  let result: TypedWorkflowOutcome;
  let workflowOutput: unknown;
  const browserRuntimeIdentity = createBrowserRuntimeIdentityRecorder(execution);
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
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
    let previewWrite = injectedPorts.previewWrite;
    if (definition.requiresPreviewWrite && !previewWrite) {
      childRpc ??= requirePGliteChildRpcClientFromEnv(launchEnv, {
        workflowId: execution.task.workflowId,
        taskRunId: execution.run.taskRunId,
      });
      await childRpc.ready;
      previewWrite = childRpc.operationalProvider.preview;
    } else if (workflowUsesPreviewWrite(definition) && !previewWrite && childRpc) {
      previewWrite = childRpc.operationalProvider.preview;
    }
    let accountIdentity = injectedPorts.accountIdentity;
    if (definition.requiresAccountIdentity && !accountIdentity) {
      childRpc ??= requirePGliteChildRpcClientFromEnv(launchEnv, {
        workflowId: execution.task.workflowId,
        taskRunId: execution.run.taskRunId,
      });
      await childRpc.ready;
      const { financial } = childRpc;
      accountIdentity = { continuity: (request) => financial.request("financial.accountIdentity.continuity", [request]) };
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
        signal,
        userDataDirectory,
        startUrl,
        browserProfile,
        onRuntimeIdentity: browserRuntimeIdentity.record,
      })
      ?? createAppWorkflowBrowserPort({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal,
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
        ?? createAppWorkflowHumanAssistancePort({ run: execution.run }),
      ...(financialCommit ? { financialCommit } : {}),
      ...(injectedPorts.tdcc ? { tdcc: injectedPorts.tdcc } : {}),
      ...(accountIdentity ? { accountIdentity } : {}),
      ...(previewWrite ? { previewWrite } : {}),
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
        { automation: execution.run.persistence },
      );
    }
    workflowOutput = await executor.run(
      execution.task.workflowId,
      execution.run.taskRunId,
      input,
      signal,
    );
    await browserRuntimeIdentity.flush();
    result = { errorCode: null, summary: summarizeTypedWorkflowOutput(workflowOutput) };
  } catch (error) {
    try {
      await browserRuntimeIdentity.flush();
    } catch {
      // Preserve only a stable workflow failure; persistence errors are opaque.
    }
    const cancelled = signal.aborted;
    let events: readonly WorkflowRunEvent[] = [];
    try {
      events = (await execution.run.persistence.taskRunById(execution.run.taskRunId))?.events ?? [];
    } catch {
      // Classification falls back to the opaque workflow code if events are unavailable.
    }
    // Provider exceptions may contain account or invoice data. Persist only
    // a stable task-level classification in the operational database.
    result = {
      errorCode: classifyTypedWorkflowFailure(error, events, cancelled),
      summary: summarizeInterruptedProductCollection(error)
        ?? summarizeTypedWorkflowOutput(workflowOutput),
    };
    if (!cancelled) {
      await recordWorkflowFailure(execution, options, {
        source: "workflow-host",
        errorCode: result.errorCode ?? "workflow-failed",
        stage: lastWorkflowStage(events),
        error,
      });
    }
  } finally {
    unregisterHumanAssistance?.();
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
): TypedWorkflowOutcome {
  // An ambiguous commit keeps its code through finalization. Marking it
  // cancelled would hide the uncertain financial outcome from the App.
  return {
    errorCode: outcome.status === "completed" ? null : errorCode,
    summary: outcome.summary,
  };
}

function tdccSessionHost(options: AutomationTaskExecutionOptions): TdccSessionHost {
  if (options.createTdccSessionHost) return options.createTdccSessionHost();
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  return createTdccSessionHost(createTdccSecretStore(AUTOMATION_CREDENTIALS_PATH, codec));
}

async function executeSupervisedAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<TypedWorkflowOutcome> {
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

  previewStructureReports.clear(execution.task.id);
  const recordPreviewFailure = (
    errorCode: string,
    events: readonly WorkflowRunEvent[],
    shapes: PreviewResponseShapes = { responses: [], omittedResponses: 0 },
  ) => {
    previewStructureReports.recordFailure(execution.task.id, {
      stage: lastWorkflowStage(events) ?? null,
      errorCode,
      shapes,
    });
  };

  const { signal, forceSignal } = execution.run;
  let unregisterHumanAssistance: (() => void) | undefined;
  let result: TypedWorkflowOutcome;
  let workerOutcome: Awaited<ReturnType<typeof runSupervisedAppWorkflow>> | undefined;
  const observedEvents: WorkflowRunEvent[] = [];
  let priorEventCount: number | null = null;
  const browserRuntimeIdentity = createBrowserRuntimeIdentityRecorder(execution);
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    try {
      const existing = await execution.run.persistence.taskRunById(execution.run.taskRunId);
      priorEventCount = existing?.events.length ?? null;
    } catch {
      // Worker events are also observed in memory before persistence is ACKed.
    }

    const input = workflowInputForTask(workflowId, launchEnv);
    const progressReporter = createWorkflowProgressReporter(execution, options, input);
    const runtime = workflowRuntimeForTask(workflowId);
    const pgliteRpc = (definition.requiresFinancialCommit || definition.requiresPreviewWrite || runtime.kind === "nonbrowser")
      ? pgliteRpcForWorker(launchEnv)
      : undefined;
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const browser = runtime.kind === "nonbrowser" ? undefined : options.workflowBrowserPortFactory?.({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
    }) ?? createAppWorkflowBrowserPort({
      taskId: execution.task.id,
      taskRunId: execution.run.taskRunId,
      signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
      nativeDialogOwner: "worker",
    });
    const humanAssistance = createAppWorkflowHumanAssistancePort({ run: execution.run });
    if (!options.verificationRouteOwnedByCampaign) {
      unregisterHumanAssistance = await registerWorkflowHumanAssistanceForTask(
        workflowId,
        { automation: execution.run.persistence },
      );
    }

    const runWorker = async (browserConnection?: AppWorkflowBrowserConnection) => {
      signal.throwIfAborted();
      return await runSupervisedAppWorkflow({
        runId: execution.run.taskRunId,
        workflowId,
        input,
        ...(browserConnection ? { browserConnection } : {}),
        ...(pgliteRpc ? { pgliteRpc } : {}),
        signal,
        forceSignal,
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
        ...(definition.requiresTdcc ? { tdccSession: tdccSessionHost(options) } : {}),
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
      const persisted = await execution.run.persistence.taskRunById(execution.run.taskRunId);
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
        recordPreviewFailure(errorCode, eventsForExecution, outcome.previewResponses);
      }
    }
  } catch (error) {
    try {
      await browserRuntimeIdentity.flush();
    } catch {
      // Preserve only a stable workflow failure; persistence errors are opaque.
    }
    const cancelled = signal.aborted;
    let eventsForExecution: readonly WorkflowRunEvent[] = observedEvents;
    try {
      const persisted = await execution.run.persistence.taskRunById(execution.run.taskRunId);
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
      recordPreviewFailure(errorCode, eventsForExecution);
    }
  } finally {
    unregisterHumanAssistance?.();
  }
  return result!;
}

export function automationProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  return automationConfigEnv({ baseEnv });
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

const CANCELLED: TypedWorkflowOutcome = { errorCode: "cancelled", summary: null };

/** Execute one workflow round of an Active Automation Task Run and report its outcome. */
export async function runAutomationTaskExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  run: ActiveAutomationTaskRun,
  options: AutomationTaskExecutionOptions,
): Promise<TypedWorkflowOutcome> {
  if (run.signal.aborted) return CANCELLED;
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
  const attempt = options.attempt ?? 1;
  const current = run.current();
  const started = await run.transition("running", {
    attempt,
    maxAttempts: options.maxAttempts ?? 1,
    progress: current.progress ? { ...current.progress, attempt } : indeterminateProgress(attempt),
  });
  if (!started) return CANCELLED;
  return executeAppWorkflow(
    { task, run, executionId: options.executionId ?? randomUUID() },
    options,
  );
}
