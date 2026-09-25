import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import type { StatementRunSummary } from "../statement-run-summary.ts";
import type {
  TypedWorkflowErrorCode,
  TypedWorkflowOutcomeSummary,
} from "./typed-workflow-outcome.ts";
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

export type AutomationTaskRunExecution = {
  task: NonNullable<ReturnType<typeof taskById>>;
  persistence: AutomationPersistenceProvider["automation"];
  run: Pick<AutomationTaskRun, "taskRunId" | "attempt">;
  executionId: string;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
};

export type AutomationTaskRunFinalizationContext = {
  provider: AutomationPersistenceProvider;
  taskId: string;
  taskKind: AutomationTaskKind;
  taskRunId: string;
  forceTerminated?: boolean;
  dataVersionStore?: DataVersionStore;
};

/** In-memory result from one App workflow execution. Provider text is never persisted. */
export type AutomationTaskExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  statementSummary: StatementRunSummary | null;
  appWorkflowOutcome?: Readonly<{
    errorCode: TypedWorkflowErrorCode | null;
    summary: TypedWorkflowOutcomeSummary | null;
  }>;
  outputPersistenceWarnings: string[];
  externalPrerequisiteIds: string[];
};

export type AsyncTaskRunFinalizationIntent = {
  status: AutomationTaskStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  appWorkflowOutcome?: AutomationTaskExecutionResult["appWorkflowOutcome"];
  terminationMode?: "forced";
};

export async function finalizeTaskRunTransition(
  provider: AutomationPersistenceProvider,
  run: Pick<AutomationTaskRun, "taskRunId">,
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

/** Persist typed outcome codes and bounded summaries through the operational port. */
export async function finalizeAutomationTaskRun(
  context: AutomationTaskRunFinalizationContext,
  result: AutomationTaskExecutionResult,
) {
  const outcome = result.appWorkflowOutcome;
  const cancelled = context.forceTerminated === true
    || result.signal === "SIGTERM"
    || result.error?.message === "Automation task cancelled."
    || outcome?.errorCode === "cancelled";
  const partial = outcome?.summary?.status === "partial"
    || result.statementSummary?.status === "partial";
  const typedFailureCode = outcome?.errorCode
    ?? (result.error || (result.exitCode !== 0 && !partial)
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
  const appWorkflowOutcome = {
    errorCode: cancelled ? "cancelled" as const : typedFailureCode,
    summary: outcome?.summary ?? null,
  };
  const prerequisiteError = cancelled
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
    { taskRunId: context.taskRunId },
    {
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      appWorkflowOutcome,
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
          // Prerequisite notices keep their separate, sanitized display contract.
          errorMessage: prerequisiteError,
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
  const appWorkflowOutcome = current.appWorkflowOutcome
    ?? (status === "failed"
      ? { errorCode: "workflow-failed" as const, summary: null }
      : undefined);
  await finalizeTaskRunTransition(provider, run, {
    status,
    exitCode: null,
    signal: null,
    ...(appWorkflowOutcome === undefined ? {} : { appWorkflowOutcome }),
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
