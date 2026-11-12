import { createTdccSecretStore } from "./tdcc-secret-store.ts";
import { createTdccSessionHost, tdccSessionHostCalls } from "./tdcc-session-host.ts";
import type { ActiveAutomationTaskRun, TaskRunReport, WorkflowExecution } from "./active-task-run.ts";
import { launchedCollectionScope } from "./collection-scope.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type { WorkflowProgressStatementType } from "../workflow-executor.ts";
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
import type { AppWorkflowBrowserHostInput } from "./app-browser-host.ts";
import type { ExecutionHost } from "./execution-host.ts";
import type { BrowserRuntimeIdentity } from "./browser-runtime.ts";
import {
  createAppWorkflowHumanAssistancePort,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import { runSupervisedAppWorkflow } from "./app-workflow-worker-supervisor.ts";
import { workflowNeedsPgliteRpc } from "./app-workflow-registry.ts";
import { previewStructureReports, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";
import type { TaskRunPlan } from "./task-run-plan.ts";

/** What one Workflow execution of an Active Automation Task Run runs with. */
type ExecutionContext = Readonly<{
  plan: TaskRunPlan;
  run: ActiveAutomationTaskRun;
  execution: WorkflowExecution;
  round: WorkflowExecutionRound;
  host: ExecutionHost;
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

/** Execute one workflow round of an Active Automation Task Run and report its outcome. */
export type TaskRunExecution = (
  plan: TaskRunPlan,
  run: ActiveAutomationTaskRun,
  round: WorkflowExecutionRound,
) => Promise<TaskRunReport>;

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

async function executeSupervisedAppWorkflow(context: ExecutionContext): Promise<TaskRunReport> {
  const { plan, host } = context;
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
    const pgliteRpc = workflowNeedsPgliteRpc(definition) ? plan.pgliteRpc : undefined;
    const page = runtime.kind === "nonbrowser"
      ? undefined
      : {
        taskId: task.id,
        taskRunId: context.run.taskRunId,
        signal,
        userDataDirectory: plan.userDataDirectory,
        credentialCodec: plan.credentials.codec,
        startUrl: runtime.startUrl,
        browserProfile: runtime.browserProfile,
        onRuntimeIdentity: browserRuntimeIdentity.record,
        execution: context.execution,
        nativeDialogOwner: "worker",
      } satisfies AppWorkflowBrowserHostInput;
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      run: context.run,
      execution: context.execution,
    });

    const runWorker = async () => {
      signal.throwIfAborted();
      return await runSupervisedAppWorkflow({
        runId: context.run.taskRunId,
        workflowId,
        input,
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
          ...(definition.requiresTdcc ? tdccSessionHostCalls(createTdccSessionHost(createTdccSecretStore(plan.credentials))) : {}),
        },
        launchWorker: (start) => host.launchWorker(start, context.execution),
      });
    };
    const outcome = page
      ? await host.withPage(page, async () => {
        await browserRuntimeIdentity.flush();
        return await runWorker();
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

/** The Workflow execution whose rounds get their page and worker from `host`. */
export function createTaskRunExecution(host: ExecutionHost): TaskRunExecution {
  return async (plan, run, round) => {
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
      return await executeSupervisedAppWorkflow({ plan, run, execution, round, host });
    } finally {
      execution.end();
    }
  };
}
