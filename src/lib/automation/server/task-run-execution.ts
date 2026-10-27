import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREDENTIALS_PATH,
  automationConfigEnv,
  getAutomationCredentialCodec,
} from "./config-files.ts";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost, type TdccSessionHost } from "./tdcc-session-host.ts";
import type { ActiveAutomationTaskRun, TaskRunReport, WorkflowExecution } from "./active-task-run.ts";
import { taskById } from "./tasks.ts";
import { launchedCollectionScope } from "./collection-scope.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type {
  WorkflowBrowserPort,
  WorkflowProgressStatementType,
} from "../workflow-executor.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import {
  projectWorkflowRunProgress,
  selectedWorkflowStatementTypes,
} from "./workflow-run-progress.ts";
import { reportExecution, type ExecutionEnding } from "./execution-outcome.ts";
import { lastOperation } from "../failure-classification.ts";
import {
  appendWorkflowFailureDiagnostic,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
} from "./workflow-failure-diagnostics.ts";
import {
  createAppWorkflowBrowserPort,
  type AppWorkflowBrowserConnection,
  type AppWorkflowBrowserProfile,
} from "./app-browser-host.ts";
import type { BrowserRuntimeIdentity } from "./browser-runtime.ts";
import {
  createAppWorkflowHumanAssistancePort,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import {
  runSupervisedAppWorkflow,
  type RunSupervisedAppWorkflowOptions,
} from "./app-workflow-worker-supervisor.ts";
import {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowRuntimeForTask,
  workflowNeedsPgliteRpc,
} from "./app-workflow-registry.ts";
import { previewStructureReports, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";
import type { PGliteWorkflowRpc } from "../../../../electron/pglite-child-rpc-client.ts";

/** What one Workflow execution of an Active Automation Task Run runs with. */
type ExecutionContext = Readonly<{
  task: NonNullable<ReturnType<typeof taskById>>;
  run: ActiveAutomationTaskRun;
  execution: WorkflowExecution;
}>;

export type AutomationTaskExecutionOptions = {
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  /** The authenticated PGlite endpoint, required by every workflow that commits or reads through it. */
  pgliteRpc?: PGliteWorkflowRpc;
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  /** Answers this execution's human assistance requests; without it a request fails closed. */
  assistanceRoute?: HumanAssistanceRoute;
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
    /** Holds the opened page for this execution, as the App browser host does. */
    execution: Pick<WorkflowExecution, "hostPage">;
  }) => WorkflowBrowserPort;
};

function createWorkflowProgressReporter(
  context: ExecutionContext,
  options: AutomationTaskExecutionOptions,
  input: unknown,
) {
  let progress = context.run.current().progress ?? indeterminateProgress(context.run.current().attempt);
  const selectedStatementTypes = selectedWorkflowStatementTypes(input);
  let retrying = options.retrying === true;

  const persistProgress = async (next: AutomationTaskProgress): Promise<void> => {
    progress = next;
    try {
      await context.run.update({ progress: next });
    } catch {
      // Progress is advisory; a progress write must not turn a committed
      // workflow result into an ambiguous failure.
    }
  };

  return {
    async appendEvent(event: WorkflowRunEvent): Promise<void> {
      const authenticationSucceeded = event.stage === "authentication" && event.outcome === "completed";
      const retryIsCaughtUp = authenticationSucceeded || event.stage === "collection";
      const recordedEvent = retrying && !retryIsCaughtUp
        ? { ...event, retrying: true }
        : event;
      if (retryIsCaughtUp) retrying = false;

      await context.execution.appendEvent(recordedEvent);
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
      await persistProgress({ ...value, percent, attempt: context.run.current().attempt });
    },
  };
}

async function recordWorkflowFailure(
  context: ExecutionContext,
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
  const workflowId = context.task.workflowId;
  if (!workflowId) return;
  const launchEnv = options.launchEnv ?? automationProcessEnv();
  await appendWorkflowFailureDiagnostic(launchEnv[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
    workflowId,
    taskRunId: context.run.taskRunId,
    ...input,
  }, { repoRoot: workflowFailureDiagnosticRepoRoot(launchEnv) });
}

type BrowserRuntimeIdentityRecorder = Readonly<{
  record(identity: BrowserRuntimeIdentity): void;
  flush(): Promise<void>;
}>;

function createBrowserRuntimeIdentityRecorder(
  context: ExecutionContext,
): BrowserRuntimeIdentityRecorder {
  let pendingWrite: Promise<void> | undefined;
  let writeFailed = false;
  return {
    record(identity) {
      // The browser host reports the identity synchronously, so the write is
      // queued on the run's write chain here and awaited by flush(), which
      // turns a failed write into a failure of this execution.
      pendingWrite = context.run.update({
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

function pgliteRpcForWorker(options: AutomationTaskExecutionOptions): PGliteWorkflowRpc {
  const rpc = options.pgliteRpc;
  if (!rpc?.endpoint.trim() || !rpc.token.trim()) throw new Error("PGlite workflow transport is unavailable.");
  return rpc;
}

function tdccSessionHost(options: AutomationTaskExecutionOptions): TdccSessionHost {
  if (options.createTdccSessionHost) return options.createTdccSessionHost();
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  return createTdccSessionHost(createTdccSecretStore(AUTOMATION_CREDENTIALS_PATH, codec));
}

async function executeSupervisedAppWorkflow(
  context: ExecutionContext,
  options: AutomationTaskExecutionOptions,
): Promise<TaskRunReport> {
  const workflowId = context.task.workflowId;
  const definition = workflowDefinitionForTask(workflowId);
  if (!definition || !workflowId || definition.id !== workflowId) {
    return { summary: null, failure: { code: "workflow-failed", proven: true } };
  }

  previewStructureReports.clear(context.task.id);
  const recordPreviewFailure = (
    errorCode: string,
    events: readonly WorkflowRunEvent[],
    shapes: PreviewResponseShapes = { responses: [], omittedResponses: 0 },
  ) => {
    previewStructureReports.recordFailure(context.task.id, {
      stage: lastOperation(events)?.stage ?? null,
      errorCode,
      shapes,
    });
  };

  const { signal, forceSignal } = context.run;
  let ending: ExecutionEnding;
  let workerOutcome: Awaited<ReturnType<typeof runSupervisedAppWorkflow>> | undefined;
  const browserRuntimeIdentity = createBrowserRuntimeIdentityRecorder(context);
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    const input = workflowInputForTask(workflowId, launchEnv);
    const progressReporter = createWorkflowProgressReporter(context, options, input);
    const runtime = workflowRuntimeForTask(workflowId);
    const pgliteRpc = workflowNeedsPgliteRpc(definition, runtime)
      ? pgliteRpcForWorker(options)
      : undefined;
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const browser = runtime.kind === "nonbrowser" ? undefined : options.workflowBrowserPortFactory?.({
      taskId: context.task.id,
      taskRunId: context.run.taskRunId,
      signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
      execution: context.execution,
    }) ?? createAppWorkflowBrowserPort({
      taskId: context.task.id,
      taskRunId: context.run.taskRunId,
      signal,
      userDataDirectory,
      startUrl: runtime.startUrl,
      browserProfile: runtime.browserProfile,
      onRuntimeIdentity: browserRuntimeIdentity.record,
      execution: context.execution,
      nativeDialogOwner: "worker",
    });
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      run: context.run,
      execution: context.execution,
    });

    const runWorker = async (browserConnection?: AppWorkflowBrowserConnection) => {
      signal.throwIfAborted();
      return await runSupervisedAppWorkflow({
        runId: context.run.taskRunId,
        workflowId,
        input,
        ...(browserConnection ? { browserConnection } : {}),
        ...(pgliteRpc ? { pgliteRpc } : {}),
        signal,
        forceSignal,
        appendEvent: (event) => progressReporter.appendEvent(event),
        recordCommitAttempt: (report) => context.run.recordCommitAttempt(report),
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
        const browserConnection = options.appWorkflowBrowserConnectionForRun
          ? options.appWorkflowBrowserConnectionForRun(context.run.taskRunId)
          : context.execution.browserConnection();
        if (!browserConnection) {
          throw new Error("The App browser worker connection is unavailable for this active run.");
        }
        return await runWorker(browserConnection);
      })
      : await runWorker();
    workerOutcome = outcome;
    await browserRuntimeIdentity.flush();
    ending = { kind: "worker", outcome };
  } catch (error) {
    try {
      await browserRuntimeIdentity.flush();
    } catch {
      // Preserve only a stable workflow failure; persistence errors are opaque.
    }
    ending = {
      kind: "host-error",
      error,
      cancelled: signal.aborted,
      workerSummary: workerOutcome?.summary ?? null,
    };
  }

  const events = context.execution.events();
  const result = reportExecution(ending, events);
  const evidence = failureEvidence(ending);
  if (evidence) {
    const { shapes, ...diagnostic } = evidence;
    const errorCode = context.run.assess(result).errorCode ?? "workflow-failed";
    await recordWorkflowFailure(context, options, {
      ...diagnostic,
      errorCode,
      stage: lastOperation(events)?.stage,
    });
    recordPreviewFailure(errorCode, events, shapes);
  }
  return result;
}

/** What a failed execution leaves for diagnostics; completion and cancellation leave nothing. */
function failureEvidence(ending: ExecutionEnding) {
  if (ending.kind === "host-error") {
    return ending.cancelled ? null : { source: "workflow-host" as const, error: ending.error, shapes: undefined };
  }
  const { outcome } = ending;
  return outcome.status === "failed"
    ? { source: "workflow-worker" as const, safeError: outcome.diagnostic, shapes: outcome.previewResponses }
    : null;
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
  const execution = run.beginExecution(options.executionId ?? randomUUID(), {
    assistanceRoute: options.assistanceRoute,
    collectionScope: launchedCollectionScope(task, options.launchEnv ?? automationProcessEnv()),
  });
  try {
    return await executeSupervisedAppWorkflow({ task, run, execution }, options);
  } finally {
    execution.end();
  }
}
