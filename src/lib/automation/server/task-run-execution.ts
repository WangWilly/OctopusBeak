import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREDENTIALS_PATH,
  automationConfigEnv,
  getAutomationCredentialCodec,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost, type TdccSessionHost } from "./tdcc-session-host.ts";
import type { ActiveAutomationTaskRun, TaskRunFailure, TaskRunReport } from "./active-task-run.ts";
import { taskById } from "./tasks.ts";
import { registerCollectionScope } from "./collection-scope.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type {
  WorkflowBrowserPort,
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
} from "./typed-workflow-outcome.ts";
import {
  appendWorkflowFailureDiagnostic,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
} from "./workflow-failure-diagnostics.ts";
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
  workflowRuntimeForTask,
  workflowNeedsPgliteRpc,
  registerWorkflowHumanAssistanceForTask,
} from "./app-workflow-registry.ts";
import { previewStructureReports, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";
import type { PGliteWorkflowRpc } from "../../../../electron/pglite-child-rpc-client.ts";

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
  /** The authenticated PGlite endpoint, required by every workflow that commits or reads through it. */
  pgliteRpc?: PGliteWorkflowRpc;
  launchVerificationSettings?: AutomationSettingsFile;
  /** The surrounding CAPTCHA campaign installs this task's App route. */
  verificationRouteOwnedByCampaign?: boolean;
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** This execution is another round of the same visible run. */
  retrying?: boolean;
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

async function executeAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<TaskRunReport> {
  const scope = registerCollectionScope(
    execution.run.taskRunId,
    execution.task,
    options.launchEnv ?? automationProcessEnv(),
  );
  try {
    return await executeSupervisedAppWorkflow(execution, options);
  } finally {
    scope.release();
  }
}

const TYPED_WORKFLOW_ERROR_CODES = new Set<TypedWorkflowErrorCode>(WORKFLOW_ERROR_CODES);

function typedWorkerFailureCode(code: string): TypedWorkflowErrorCode | null {
  return TYPED_WORKFLOW_ERROR_CODES.has(code as TypedWorkflowErrorCode)
    ? code as TypedWorkflowErrorCode
    : null;
}

function pgliteRpcForWorker(options: AutomationTaskExecutionOptions): PGliteWorkflowRpc {
  const rpc = options.pgliteRpc;
  if (!rpc?.endpoint.trim() || !rpc.token.trim()) throw new Error("PGlite workflow transport is unavailable.");
  return rpc;
}

/** Only the run's Commit attempts can say a commit outcome is unknown (ADR 0056). */
function classifiedFailure(code: TypedWorkflowErrorCode): TaskRunFailure {
  return { code: code === "commit-outcome-unknown" ? "workflow-failed" : code, proven: false };
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
): Promise<TaskRunReport> {
  const workflowId = execution.task.workflowId;
  const definition = workflowDefinitionForTask(workflowId);
  if (!definition || !workflowId || definition.id !== workflowId) {
    return { summary: null, failure: { code: "workflow-failed", proven: true } };
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
  let result: TaskRunReport;
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
    const pgliteRpc = workflowNeedsPgliteRpc(definition, runtime)
      ? pgliteRpcForWorker(options)
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
          observedEvents.push(event);
          await progressReporter.appendEvent(event);
        },
        recordCommitAttempt: (report) => execution.run.recordCommitAttempt(report),
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
      result = { summary: outcome.summary, failure: null };
    } else {
      const explicitCode = outcome.status === "failed"
        ? typedWorkerFailureCode(outcome.errorCode)
        : null;
      // A structured product failure is explicit evidence, even when its code
      // is workflow-failed. Do not replace it with a guess from the last event.
      const productConfirmsCode = outcome.summary?.products?.some(
        (product) => product.status === "failed" && product.errorCode === explicitCode,
      );
      result = {
        summary: outcome.summary,
        failure: explicitCode && explicitCode !== "commit-outcome-unknown"
          && (explicitCode !== "workflow-failed" || productConfirmsCode)
          ? { code: explicitCode, proven: true }
          : classifiedFailure(classifyTypedWorkflowFailure(
            new Error("App workflow worker failed."),
            eventsForExecution,
            outcome.status === "cancelled",
          )),
      };
      if (outcome.status === "failed") {
        const errorCode = execution.run.assess(result).errorCode ?? "workflow-failed";
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
    result = {
      summary: summarizeInterruptedProductCollection(error) ?? workerOutcome?.summary ?? null,
      failure: classifiedFailure(classifyTypedWorkflowFailure(error, eventsForExecution, cancelled)),
    };
    if (!cancelled) {
      const errorCode = execution.run.assess(result).errorCode ?? "workflow-failed";
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

const CANCELLED: TaskRunReport = { summary: null, failure: { code: "cancelled", proven: true } };

/** Execute one workflow round of an Active Automation Task Run and report its outcome. */
export async function runAutomationTaskExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  run: ActiveAutomationTaskRun,
  options: AutomationTaskExecutionOptions,
): Promise<TaskRunReport> {
  if (run.signal.aborted) return CANCELLED;
  if (!task.workflowId) {
    throw new Error("App workflow definition is unavailable.");
  }
  if (workflowRuntimeForTask(task.workflowId).kind === "nonbrowser") pgliteRpcForWorker(options);
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
