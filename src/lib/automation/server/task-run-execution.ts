import {
  AUTOMATION_CREDENTIALS_PATH,
  getAutomationCredentialCodec,
} from "./config-files.ts";
import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost, tdccSessionHostCalls, type TdccSessionHost } from "./tdcc-session-host.ts";
import type { ActiveAutomationTaskRun, TaskRunReport, WorkflowExecution } from "./active-task-run.ts";
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
  buildWorkflowFailureDiagnostic,
} from "./workflow-failure-diagnostics.ts";
import { rememberFailureDiagnostic } from "./error-report.ts";
import {
  createAppWorkflowBrowserPort,
  type AppWorkflowBrowserConnection,
  type AppWorkflowBrowserHostInput,
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
import { workflowNeedsPgliteRpc } from "./app-workflow-registry.ts";
import { previewStructureReports, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";
import type { TaskRunPlan } from "./task-run-plan.ts";

/** What one Workflow execution of an Active Automation Task Run runs with. */
type ExecutionContext = Readonly<{
  plan: TaskRunPlan;
  run: ActiveAutomationTaskRun;
  execution: WorkflowExecution;
  round: WorkflowExecutionRound;
  seams: AutomationTaskExecutionSeams;
}>;

/** What the CAPTCHA Retry Campaign tells one Workflow execution about its round. */
export type WorkflowExecutionRound = Readonly<{
  attempt: number;
  maxAttempts: number;
  /** This execution is another round of the same visible run. */
  retrying: boolean;
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId: string;
  /** Answers this execution's human assistance requests; without it a request fails closed. */
  assistanceRoute?: HumanAssistanceRoute;
}>;

/** Test seams of a Workflow execution; production leaves each at its default. */
export type AutomationTaskExecutionSeams = Readonly<{
  /** The host side of a TDCC run's session port. Production reads credentials.json. */
  createTdccSessionHost?: () => TdccSessionHost;
  /** The supervised App workflow worker. Production uses Worker. */
  appWorkflowWorkerFactory?: RunSupervisedAppWorkflowOptions["workerFactory"];
  /** Proves that the worker receives the active host descriptor. */
  appWorkflowBrowserConnectionForRun?: (
    taskRunId: string,
  ) => AppWorkflowBrowserConnection | null;
  /** The browser a browser workflow runs in. Production opens the App browser host. */
  workflowBrowserPort?: (input: AppWorkflowBrowserHostInput) => WorkflowBrowserPort;
}>;

function createWorkflowProgressReporter(context: ExecutionContext, input: unknown) {
  let progress = context.run.current().progress ?? indeterminateProgress(context.run.current().attempt);
  const selectedStatementTypes = selectedWorkflowStatementTypes(input);
  let retrying = context.round.retrying;

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
  input: Readonly<{
    source: "workflow-worker" | "workflow-host";
    errorCode: string;
    stage?: WorkflowRunEvent["stage"];
    statementType?: WorkflowProgressStatementType;
    error?: unknown;
    safeError?: unknown;
  }>,
): Promise<void> {
  const { workflowId, launchEnv } = context.plan;
  const record = { workflowId, taskRunId: context.run.taskRunId, ...input };
  const options = { repoRoot: workflowFailureDiagnosticRepoRoot(launchEnv) };
  // Kept in memory for an Error report the person may choose to send (ADR 0081). Like the file
  // writer, building it must never change the failure outcome.
  try {
    rememberFailureDiagnostic(context.run.taskId, buildWorkflowFailureDiagnostic(record, options));
  } catch {
    rememberFailureDiagnostic(context.run.taskId, null);
  }
  await appendWorkflowFailureDiagnostic(launchEnv[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], record, options);
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

function tdccSessionHost(seams: AutomationTaskExecutionSeams): TdccSessionHost {
  if (seams.createTdccSessionHost) return seams.createTdccSessionHost();
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  return createTdccSessionHost(createTdccSecretStore(AUTOMATION_CREDENTIALS_PATH, codec));
}

async function executeSupervisedAppWorkflow(context: ExecutionContext): Promise<TaskRunReport> {
  const { plan, seams } = context;
  const { task, workflowId, launchEnv } = plan;
  const { definition, runtime } = plan.registration;

  previewStructureReports.clear(task.id);
  const recordPreviewFailure = (
    errorCode: string,
    events: readonly WorkflowRunEvent[],
    shapes: PreviewResponseShapes = { responses: [], omittedResponses: 0 },
  ) => {
    previewStructureReports.recordFailure(task.id, {
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
    const input = plan.registration.inputFromEnvironment(launchEnv);
    const progressReporter = createWorkflowProgressReporter(context, input);
    const pgliteRpc = workflowNeedsPgliteRpc(definition, runtime) ? plan.pgliteRpc : undefined;
    const browser = runtime.kind === "nonbrowser"
      ? undefined
      : (seams.workflowBrowserPort ?? createAppWorkflowBrowserPort)({
        taskId: task.id,
        taskRunId: context.run.taskRunId,
        signal,
        userDataDirectory: launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd(),
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
        hostCalls: {
          event: ({ event }) => progressReporter.appendEvent(event),
          commitAttempt: ({ attempt }) => context.run.recordCommitAttempt(attempt),
          humanAssistance: async ({ contract }, signal) => {
            try {
              return { status: await humanAssistance.request(contract, signal) };
            } catch {
              return { status: "failed" };
            }
          },
          ...(definition.reportsExchangeRateProgress ? {
            exchangeRateProgress: (progress) => progressReporter.appendExchangeRateProgress(progress),
          } : {}),
          ...(definition.requiresTdcc ? tdccSessionHostCalls(tdccSessionHost(seams)) : {}),
        },
        ...(seams.appWorkflowWorkerFactory
          ? { workerFactory: seams.appWorkflowWorkerFactory }
          : {}),
      });
    };
    const outcome = browser
      ? await browser.withPage(async () => {
        await browserRuntimeIdentity.flush();
        const browserConnection = seams.appWorkflowBrowserConnectionForRun
          ? seams.appWorkflowBrowserConnectionForRun(context.run.taskRunId)
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
    await recordWorkflowFailure(context, {
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
  plan: TaskRunPlan,
  run: ActiveAutomationTaskRun,
  round: WorkflowExecutionRound,
  seams: AutomationTaskExecutionSeams = {},
): Promise<TaskRunReport> {
  if (run.signal.aborted) return CANCELLED;
  const { attempt } = round;
  const current = run.current();
  const started = await run.transition("running", {
    attempt,
    maxAttempts: round.maxAttempts,
    progress: current.progress ? { ...current.progress, attempt } : indeterminateProgress(attempt),
  });
  if (!started) return CANCELLED;
  const execution = run.beginExecution(round.executionId, {
    assistanceRoute: round.assistanceRoute,
    collectionScope: launchedCollectionScope(plan.task, plan.launchEnv),
  });
  try {
    return await executeSupervisedAppWorkflow({ plan, run, execution, round, seams });
  } finally {
    execution.end();
  }
}
