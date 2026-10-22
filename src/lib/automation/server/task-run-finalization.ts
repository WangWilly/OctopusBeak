import type {
  TypedWorkflowErrorCode,
  TypedWorkflowOutcome,
  TypedWorkflowOutcomeSummary,
} from "./typed-workflow-outcome.ts";
import { tdccIncompleteCollectionHasDurableReceipts } from "../tdcc-collection-summary.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import { taskById } from "./tasks.ts";
import { commitAttemptsErrorCode, commitAttemptsMayHaveCommitted } from "../commit-attempt.ts";
import {
  isTerminalTaskRunStatus,
  type AutomationPersistencePort,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type TerminalTaskRunStatus,
} from "./store.ts";
import {
  dataVersionStore,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";

/** Why an Active Automation Task Run was asked to stop before it ended on its own. */
export type TaskRunStop = "cancelled" | "forced" | "shutdown";

export type TaskRunOutcome = Readonly<{
  status: TerminalTaskRunStatus;
  errorCode: TypedWorkflowErrorCode | null;
  summary: TypedWorkflowOutcomeSummary | null;
  forced: boolean;
}>;

/**
 * Resolve a run's terminal outcome from what its execution reported and why it
 * was stopped. An unknown commit outcome outranks every stop so an uncertain
 * financial write is never hidden; a person's cancellation outranks shutdown.
 */
export function decideAutomationTaskRunOutcome(
  report: TypedWorkflowOutcome,
  stop: TaskRunStop | null,
): TaskRunOutcome {
  const { errorCode, summary } = report;
  const outcome = (
    status: TerminalTaskRunStatus,
    code: TypedWorkflowErrorCode | null,
    forced = false,
  ): TaskRunOutcome => ({ status, errorCode: code, summary, forced });
  if (errorCode === "commit-outcome-unknown") return outcome("failed", errorCode);
  if (stop === "forced") return outcome("cancelled", "cancelled", true);
  if (stop === "cancelled") return outcome("cancelled", "cancelled");
  if (stop === "shutdown") return outcome("interrupted", "cancelled");
  if (errorCode === "cancelled") return outcome("cancelled", "cancelled");
  if (tdccIncompleteCollectionHasDurableReceipts(summary, errorCode)) return outcome("partial", errorCode);
  if (errorCode !== null || summary?.status === "failed") return outcome("failed", errorCode);
  if (summary?.status === "partial") return outcome("partial", null);
  return outcome("completed", null);
}

/** Persist a terminal outcome once. A run that is already terminal is returned unchanged. */
export async function finalizeAutomationTaskRun(
  persistence: AutomationPersistencePort,
  taskRunId: string,
  outcome: TaskRunOutcome,
  options: { dataVersionStore?: DataVersionStore } = {},
): Promise<AutomationTaskRun> {
  const current = await persistence.taskRunById(taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) return current;
  const finishedAt = new Date().toISOString();
  const transition = await persistence.transitionTaskRunToTerminal(taskRunId, {
    status: outcome.status,
    finishedAt,
    appWorkflowOutcome: { errorCode: outcome.errorCode, summary: outcome.summary },
    ...(outcome.status === "completed" ? {
      progress: current.progress?.phaseCode === "complete"
        ? { ...current.progress, percent: 100, attempt: current.attempt }
        : {
          ...current.progress,
          phaseCode: "workflow-finalization",
          completed: 1,
          total: 1,
          percent: 100,
          attempt: current.attempt,
        },
    } : {}),
    ...(outcome.forced ? { terminationMode: "forced" as const } : {}),
  });
  if (transition.applied) {
    const committedProductCount = outcome.summary?.counts.committedCount
      ?? outcome.summary?.products?.reduce((total, product) => total + product.committedCount, 0)
      ?? 0;
    if (outcome.status === "completed" || outcome.status === "partial"
      || committedProductCount > 0
      || commitAttemptsMayHaveCommitted(await persistence.commitAttempts(taskRunId))) {
      (options.dataVersionStore ?? dataVersionStore).markStale("automation-completed");
    }
    if (outcome.status === "completed") {
      await persistence.resolveTaskPrerequisiteNotices(current.taskId, taskRunId, finishedAt);
    } else if (outcome.errorCode === "external-prerequisite-unavailable") {
      // The workflow names the missing component by the run event its metadata declares.
      const recorded = new Set(current.events.map((event) => event.code));
      for (const prerequisite of taskById(current.taskId)?.externalPrerequisites ?? []) {
        if (!isValidExternalPrerequisiteMetadata(prerequisite)) continue;
        if (!recorded.has(prerequisite.unavailableEventCode)) continue;
        await persistence.upsertTaskPrerequisiteNotice({
          taskId: current.taskId,
          prerequisiteId: prerequisite.id,
          taskRunId,
          detectedAt: finishedAt,
        });
      }
    }
  }
  const finalized = await persistence.taskRunById(taskRunId);
  if (!finalized) throw new Error(`Missing automation task run: ${taskRunId}`);
  return finalized;
}

/**
 * Record a run left active by a previous process. No Active Automation Task Run
 * owns it. An unsettled Commit attempt makes it commit outcome unknown; any
 * other leftover row is an Interrupted run (ADR 0056).
 */
export async function finalizePersistedRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  _reason: string,
  status: Extract<TerminalTaskRunStatus, "failed" | "interrupted"> = "failed",
  options: { dataVersionStore?: DataVersionStore } = {},
): Promise<void> {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || isTerminalTaskRunStatus(current.status)) return;
  const attempts = await provider.automation.commitAttempts(run.taskRunId);
  const summary = current.appWorkflowOutcome?.summary ?? null;
  const [terminal, appWorkflowOutcome]: readonly [TerminalTaskRunStatus, TypedWorkflowOutcome] =
    commitAttemptsErrorCode(attempts) === "commit-outcome-unknown"
      ? ["failed", { errorCode: "commit-outcome-unknown", summary }]
      : status === "interrupted"
        ? [status, { errorCode: "cancelled", summary }]
        : [status, current.appWorkflowOutcome ?? { errorCode: "workflow-failed", summary: null }];
  const transition = await provider.automation.transitionTaskRunToTerminal(run.taskRunId, {
    status: terminal,
    finishedAt: new Date().toISOString(),
    appWorkflowOutcome,
  });
  if (transition.applied && commitAttemptsMayHaveCommitted(attempts)) {
    (options.dataVersionStore ?? dataVersionStore).markStale("automation-completed");
  }
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
