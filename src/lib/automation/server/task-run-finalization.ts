import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import type { StatementRunSummary } from "../statement-run-summary.ts";
import { resolveTaskCommand } from "./desktop-command.ts";
import {
  forceQuitAutomationSessionForRun,
  type ForceQuitFinalizationDependencies,
  type OwnedAutomationSession,
} from "./automation-session-disposition.ts";
import type {
  TypedWorkflowErrorCode,
  TypedWorkflowOutcomeSummary,
} from "./typed-workflow-outcome.ts";
export type { ForceQuitFinalizationDependencies } from "./automation-session-disposition.ts";
import {
  isActiveTaskRunStatus,
  isTerminalTaskRunStatus,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { taskById, type AutomationTaskKind } from "./tasks.ts";
import {
  dataVersionStore,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";
import {
  automationRuntimeState,
  runtimeTaskSnapshotFromRun,
} from "./runtime-state.ts";

export type AutomationTaskRunExecution = {
  task: NonNullable<ReturnType<typeof taskById>>;
  persistence: AutomationPersistenceProvider["automation"];
  run: Pick<AutomationTaskRun, "taskRunId" | "attempt">;
  logPath: string;
  command: ReturnType<typeof resolveTaskCommand>;
  session: string | null;
  owner: OwnedAutomationSession | null;
  executionId: string;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
};

export type AutomationTaskRunFinalizationContext = {
  provider: AutomationPersistenceProvider;
  taskId: string;
  taskKind: AutomationTaskKind;
  taskRunId: string;
  logPath: string;
  forceTerminated?: boolean;
  /** The coordinator has already cleaned the exact browser session. */
  sessionAlreadyCleaned?: boolean;
  dataVersionStore?: DataVersionStore;
};

export type AutomationTaskProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  logTail: string;
  resumeFailure: string | null;
  statementSummary: StatementRunSummary | null;
  /** Typed App result kept on the process boundary for durable finalization. */
  appWorkflowOutcome?: Readonly<{
    errorCode: TypedWorkflowErrorCode | null;
    summary: TypedWorkflowOutcomeSummary | null;
  }>;
  outputPersistenceWarnings: string[];
  externalPrerequisiteIds: string[];
};

/** Compatibility shim for the retired stdout-driven human-assistance protocol. */
export function shouldMarkWaitingForHuman(_output: string) {
  return false;
}

export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  waitingForHuman?: boolean;
}): AutomationTaskStatus {
  // The typed App executor owns human-assistance pauses; process output is not
  // an authority for moving a run into that state.
  void input.waitingForHuman;
  if (input.exitCode === 0) return "completed";
  return "failed";
}

export type AsyncTaskRunFinalizationIntent = {
  status: AutomationTaskStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
  logTail: string;
  appWorkflowOutcome?: AutomationTaskProcessResult["appWorkflowOutcome"];
  terminationMode?: "forced";
};

export async function finalizeTaskRunTransition(
  provider: AutomationPersistenceProvider,
  run: Pick<AutomationTaskRun, "taskRunId" | "logPath">,
  intent: AsyncTaskRunFinalizationIntent,
) {
  const persistence = provider.automation;
  const current = await persistence.taskRunById(run.taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) {
    return { status: current.status, skipped: true } as const;
  }
  if (!isActiveTaskRunStatus(current.status) || current.status === "queued") {
    return { status: current.status, skipped: true } as const;
  }
  if (intent.status === "waiting_for_human") {
    await persistence.updateTaskRun(run.taskRunId, {
      status: intent.status,
      finishedAt: null,
      exitCode: intent.exitCode,
      signal: intent.signal,
      errorMessage: intent.errorMessage,
      logTail: "",
      ...(intent.appWorkflowOutcome === undefined
        ? {}
        : { appWorkflowOutcome: intent.appWorkflowOutcome }),
    });
    const persisted = await persistence.taskRunById(run.taskRunId);
    if (!persisted) throw new Error(`Missing automation task run: ${run.taskRunId}`);
    return { status: persisted.status, skipped: false } as const;
  }
  if (!isTerminalTaskRunStatus(intent.status)) {
    return { status: current.status, skipped: true } as const;
  }
  const transition = await persistence.transitionTaskRunToTerminal(run.taskRunId, {
    status: intent.status,
    finishedAt: new Date().toISOString(),
    exitCode: intent.exitCode,
    signal: intent.signal,
    errorMessage: intent.errorMessage,
    logTail: "",
    ...(intent.appWorkflowOutcome === undefined
      ? {}
      : { appWorkflowOutcome: intent.appWorkflowOutcome }),
    ...(intent.terminationMode ? { terminationMode: intent.terminationMode } : {}),
  });
  if (!transition.applied) {
    return { status: transition.status, skipped: true } as const;
  }
  const persisted = await persistence.taskRunById(run.taskRunId);
  if (!persisted) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  return { status: persisted.status, skipped: false } as const;
}

/**
 * Persist a typed App workflow outcome through the injected operational port.
 * Provider exception text and process output are deliberately excluded from
 * the durable run record.
 */
export async function finalizeAutomationTaskRun(
  context: AutomationTaskRunFinalizationContext,
  result: AutomationTaskProcessResult,
) {
  const outcome = result.appWorkflowOutcome;
  const cancelled = context.forceTerminated === true
    || result.signal === "SIGTERM"
    || result.error?.message === "Automation task cancelled."
    || outcome?.errorCode === "cancelled";
  const partial = outcome?.summary?.status === "partial"
    || result.statementSummary?.status === "partial";
  const typedFailureCode = outcome?.errorCode
    ?? (result.error || result.resumeFailure || (result.exitCode !== 0 && !partial)
      ? "workflow-failed"
      : null);
  let status: AutomationTaskStatus;
  if (cancelled) {
    status = "cancelled";
  } else if (typedFailureCode !== null || outcome?.summary?.status === "failed") {
    status = "failed";
  } else if (partial) {
    status = "partial";
  } else {
    status = result.exitCode === 0 ? "completed" : "failed";
  }
  const persistedOutcome = outcome === undefined
    ? undefined
    : {
      errorCode: cancelled ? "cancelled" as const : outcome.errorCode ?? typedFailureCode,
      summary: outcome.summary,
    };
  const taskError = cancelled
    ? "Workflow cancelled."
    : status === "failed"
    ? `Workflow failed (${typedFailureCode ?? "workflow-failed"}).`
    : null;
  const persistence = context.provider.automation;
  const currentRun = await persistence.taskRunById(context.taskRunId);
  if (!currentRun) throw new Error(`Missing automation task run: ${context.taskRunId}`);
  if (isTerminalTaskRunStatus(currentRun.status)) return { status: currentRun.status };
  const transition = await finalizeTaskRunTransition(
    context.provider,
    { taskRunId: context.taskRunId, logPath: context.logPath },
    {
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      errorMessage: taskError,
      logTail: "",
      ...(persistedOutcome === undefined
        ? {}
        : { appWorkflowOutcome: persistedOutcome }),
      ...(status === "cancelled" && context.forceTerminated
        ? { terminationMode: "forced" as const }
        : {}),
    },
  );
  if (!transition.skipped) {
    if (transition.status === "completed" || transition.status === "partial") {
      (context.dataVersionStore ?? dataVersionStore).markStale("automation-completed");
    }
    const task = taskById(context.taskId);
    const prerequisites = new Map(
      (task?.externalPrerequisites ?? [])
        .filter(isValidExternalPrerequisiteMetadata)
        .map((prerequisite) => [prerequisite.id, prerequisite]),
    );
    if (transition.status === "completed") {
      await persistence.resolveTaskPrerequisiteNotices(
        context.taskId,
        context.taskRunId,
        new Date().toISOString(),
      );
    } else if (transition.status === "failed" || transition.status === "partial") {
      const detectedAt = new Date().toISOString();
      for (const prerequisiteId of result.externalPrerequisiteIds) {
        if (!prerequisites.has(prerequisiteId)) continue;
        await persistence.upsertTaskPrerequisiteNotice({
          taskId: context.taskId,
          prerequisiteId,
          taskRunId: context.taskRunId,
          detectedAt,
          errorMessage: taskError,
        });
      }
    }
  }
  return { status: transition.status };
}

export async function finalizePersistedRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  _reason: string,
  status: Extract<AutomationTaskStatus, "failed" | "interrupted"> = "failed",
): Promise<void> {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || isTerminalTaskRunStatus(current.status)) return;
  await finalizeTaskRunTransition(provider, run, {
    status,
    exitCode: null,
    signal: null,
    errorMessage: status === "interrupted"
      ? "Workflow interrupted because the App closed."
      : current.appWorkflowOutcome?.errorCode
        ? `Workflow failed (${current.appWorkflowOutcome.errorCode}).`
        : "Workflow failed (workflow-failed).",
    logTail: "",
    ...(current.appWorkflowOutcome === undefined || current.appWorkflowOutcome === null
      ? {}
      : { appWorkflowOutcome: current.appWorkflowOutcome }),
  });
}

export async function finalizeForceQuitTaskRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  dependencies: ForceQuitFinalizationDependencies = {},
) {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || current.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${run.taskId}`);
  }
  const { operationalError, ...sessionCleanup } = await forceQuitAutomationSessionForRun(
    run,
    dependencies,
  );
  const appWorkflowOutcome = current.appWorkflowOutcome === undefined
    || current.appWorkflowOutcome === null
    ? undefined
    : {
      errorCode: "cancelled" as const,
      summary: current.appWorkflowOutcome.summary,
    };
  await finalizeTaskRunTransition(provider, run, {
    status: "cancelled",
    exitCode: null,
    signal: null,
    errorMessage: sessionCleanup.errorMessage,
    logTail: run.logTail,
    terminationMode: "forced",
    ...(appWorkflowOutcome === undefined ? {} : { appWorkflowOutcome }),
  });
  if (operationalError) throw operationalError;
  return { session: sessionCleanup.session };
}

export async function finalizeFailedWaitingRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  _workflowError: string,
) {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || current.status !== "waiting_for_human") return;
  const currentOutcome = current.appWorkflowOutcome;
  const appWorkflowOutcome = {
    errorCode: currentOutcome?.errorCode ?? "workflow-failed" as const,
    summary: currentOutcome?.summary ?? null,
  };
  await finalizeTaskRunTransition(provider, run, {
    status: "failed",
    exitCode: null,
    signal: null,
    errorMessage: `Workflow failed (${appWorkflowOutcome.errorCode ?? "workflow-failed"}).`,
    logTail: "",
    appWorkflowOutcome,
  });
}

export async function finalizePersistedActiveRuns(
  provider: AutomationPersistenceProvider,
  reason: string,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const run of await provider.automation.activeTaskRuns()) {
      try {
        await finalizePersistedRun(provider, run, reason, "interrupted");
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}
