import type { AutomationRuntimeTaskSnapshot } from "$lib/desktop/api.ts";
import {
  canTransitionTaskRun,
  isTerminalTaskRunStatus,
  type ActiveTaskRunStatus,
  type AutomationPersistencePort,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type AutomationTaskRunUpdate,
  type TerminalTaskRunStatus,
} from "./store.ts";
import { runtimeTaskSnapshotFromRun } from "./runtime-state.ts";
import type {
  TypedWorkflowErrorCode,
  TypedWorkflowOutcomeSummary,
} from "./typed-workflow-outcome.ts";
import {
  applyCommitAttemptReport,
  commitAttemptsErrorCode,
  commitAttemptsMayHaveCommitted,
  type CommitAttempt,
  type CommitAttemptReport,
} from "../commit-attempt.ts";
import { tdccIncompleteCollectionHasDurableReceipts } from "../tdcc-collection-summary.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import { taskById } from "./tasks.ts";
import {
  dataVersionStore as defaultDataVersionStore,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";

export type ActiveTaskRunFields = Pick<AutomationTaskRunUpdate, "attempt" | "maxAttempts" | "progress">;

/** Why an Active Automation Task Run was asked to stop before it ended on its own. */
export type TaskRunStop = "cancelled" | "forced" | "shutdown";

/**
 * Only a Commit attempt can make a run commit outcome unknown (ADR 0056), so
 * an execution cannot report it.
 */
export type TaskRunFailure = Readonly<{
  code: Exclude<TypedWorkflowErrorCode, "commit-outcome-unknown">;
  /** False when the code was classified from run events, so a failed Commit attempt explains the run better. */
  proven: boolean;
}>;

/** What an execution observed, before the run's Commit attempts and stop are applied. */
export type TaskRunReport = Readonly<{
  summary: TypedWorkflowOutcomeSummary | null;
  /** Null when the workflow completed. */
  failure: TaskRunFailure | null;
}>;

export type TaskRunOutcome = Readonly<{
  status: TerminalTaskRunStatus;
  errorCode: TypedWorkflowErrorCode | null;
  summary: TypedWorkflowOutcomeSummary | null;
  forced: boolean;
}>;

/** The sole owner of one Automation Task Run until its finalization (ADR 0052). */
export type ActiveAutomationTaskRun = Readonly<{
  taskId: string;
  taskRunId: string;
  persistence: AutomationPersistencePort;
  /** Aborted with a TaskRunStop reason on cancellation, force-quit or shutdown. */
  signal: AbortSignal;
  /** Aborted only on force-quit, which allows no cleanup grace. */
  forceSignal: AbortSignal;
  /** The strongest stop requested so far, or null. */
  stopReason(): TaskRunStop | null;
  /** The last persisted row this owner wrote. */
  current(): AutomationTaskRun;
  /** Move to an active status. False when the table or the store refuses it. */
  transition(status: ActiveTaskRunStatus, fields?: ActiveTaskRunFields): Promise<boolean>;
  /** Record non-status fields. Ignored once the run has finished. */
  update(fields: ActiveTaskRunFields): Promise<void>;
  /** Durably append one Commit attempt phase and keep it for the run's outcome (ADR 0056). */
  recordCommitAttempt(report: CommitAttemptReport): Promise<void>;
  requestStop(reason: TaskRunStop): Promise<void>;
  /** The outcome this report and the run's Commit attempts give, before any stop is applied. */
  assess(report: TaskRunReport): TaskRunOutcome;
  /** Persist the terminal outcome. Later calls return the first result. */
  finish(report: TaskRunReport): Promise<AutomationTaskRun>;
}>;

type RuntimeStatePort = Readonly<{
  upsert(task: AutomationRuntimeTaskSnapshot): unknown;
}>;

const STOP_RANK: Readonly<Record<TaskRunStop, number>> = { shutdown: 1, cancelled: 2, forced: 3 };

/** Ordinary cancellation gets this long to clean up before force-quit is offered. */
export const FORCE_QUIT_AVAILABLE_AFTER_MS = 10_000;

/**
 * The run's Commit attempts outrank its report: an unsettled attempt makes it
 * commit outcome unknown and a refused one collection scope changed (ADR 0058).
 * Unknown also outranks every stop so an uncertain financial write is never
 * hidden; a person's cancellation outranks shutdown.
 */
function decide(
  attempts: readonly CommitAttempt[],
  report: TaskRunReport,
  stop: TaskRunStop | null,
): TaskRunOutcome {
  const { failure, summary } = report;
  const commit = commitAttemptsErrorCode(attempts);
  const errorCode = commit === "commit-outcome-unknown" || commit === "collection-scope-changed"
    ? commit
    : failure === null
      ? null
      : failure.proven ? failure.code : commit ?? failure.code;
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
async function persistTerminal(
  persistence: AutomationPersistencePort,
  taskRunId: string,
  outcome: TaskRunOutcome,
  attempts: readonly CommitAttempt[],
  dataVersionStore: DataVersionStore,
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
      || commitAttemptsMayHaveCommitted(attempts)) {
      dataVersionStore.markStale("automation-completed");
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

export function openActiveTaskRun(input: Readonly<{
  run: AutomationTaskRun;
  persistence: AutomationPersistencePort;
  runtime: RuntimeStatePort;
  forceQuitAvailableAfterMs?: number;
  dataVersionStore?: DataVersionStore;
}>): ActiveAutomationTaskRun {
  const { persistence, runtime } = input;
  const taskRunId = input.run.taskRunId;
  const stopController = new AbortController();
  const forceController = new AbortController();
  let row = input.run;
  let stop: TaskRunStop | null = null;
  let attempts: readonly CommitAttempt[] = [];
  let recording: Promise<unknown> = Promise.resolve();
  let cancellationRequestedAt: string | null = null;
  let forceTerminateAvailable = false;
  let forceQuitTimer: ReturnType<typeof setTimeout> | undefined;
  let finishing: Promise<AutomationTaskRun> | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  // Writes are serialized so each transition is checked against the status
  // the previous write left, never against a status another write is replacing.
  const serialized = <T>(write: () => Promise<T>): Promise<T> => {
    const next = writes.then(write);
    writes = next.catch(() => undefined);
    return next;
  };

  const publish = () => {
    runtime.upsert({
      ...runtimeTaskSnapshotFromRun(row),
      ...(cancellationRequestedAt === null ? {} : { cancellationRequestedAt, forceTerminateAvailable }),
    });
  };

  const transition = (status: ActiveTaskRunStatus, fields: ActiveTaskRunFields = {}) =>
    serialized(async () => {
      if (finishing || !canTransitionTaskRun(row.status, status)) return false;
      const result = await persistence.transitionTaskRunToActive(taskRunId, { ...fields, status });
      if (!result.applied) return false;
      row = { ...row, ...fields, status };
      publish();
      return true;
    });

  const run: ActiveAutomationTaskRun = {
    taskId: row.taskId,
    taskRunId,
    persistence,
    signal: stopController.signal,
    forceSignal: forceController.signal,
    stopReason: () => stop,
    current: () => row,
    transition,
    update: (fields) => serialized(async () => {
      if (finishing) return;
      await persistence.updateTaskRun(taskRunId, fields);
      row = { ...row, ...fields };
      publish();
    }),
    recordCommitAttempt(report) {
      const recorded = recording.then(async () => {
        // A settlement describes a commit that already ran, so it counts even
        // if storing it fails. The worker commits only after a start is
        // stored, so a start counts once it is durable.
        if (report.phase === "settled") attempts = applyCommitAttemptReport(attempts, report);
        await persistence.recordCommitAttempt(taskRunId, report);
        if (report.phase === "started") attempts = applyCommitAttemptReport(attempts, report);
      });
      recording = recorded.catch(() => undefined);
      return recorded;
    },
    async requestStop(reason) {
      if (finishing) return;
      if (stop === null || STOP_RANK[reason] > STOP_RANK[stop]) stop = reason;
      if (reason !== "shutdown") {
        cancellationRequestedAt ??= new Date().toISOString();
        if (reason === "forced") forceTerminateAvailable = true;
      }
      if (!stopController.signal.aborted) stopController.abort(reason);
      if (reason === "forced" && !forceController.signal.aborted) forceController.abort(reason);
      if (reason === "cancelled" && forceQuitTimer === undefined && !forceTerminateAvailable) {
        forceQuitTimer = setTimeout(() => {
          if (finishing) return;
          forceTerminateAvailable = true;
          publish();
        }, input.forceQuitAvailableAfterMs ?? FORCE_QUIT_AVAILABLE_AFTER_MS);
        forceQuitTimer.unref?.();
      }
      if (reason === "shutdown") return;
      if (!(await transition("cancelling")) && !finishing) publish();
    },
    assess: (report) => decide(attempts, report, null),
    finish(report) {
      finishing ??= serialized(async () => {
        if (forceQuitTimer) clearTimeout(forceQuitTimer);
        await recording;
        row = await persistTerminal(
          persistence,
          taskRunId,
          decide(attempts, report, stop),
          attempts,
          input.dataVersionStore ?? defaultDataVersionStore,
        );
        runtime.upsert(runtimeTaskSnapshotFromRun(row));
        return row;
      });
      return finishing;
    },
  };
  publish();
  return run;
}

/**
 * Finish the runs a previous process left active. No Active Automation Task
 * Run owns them, so their stored Commit attempts decide: an unsettled one is
 * commit outcome unknown, and any other leftover row is an Interrupted run.
 */
export async function finalizeOrphanedRuns(
  provider: AutomationPersistenceProvider,
  options: Readonly<{ dataVersionStore?: DataVersionStore }> = {},
): Promise<void> {
  const persistence = provider.automation;
  const errors: unknown[] = [];
  try {
    for (const run of await persistence.activeTaskRuns()) {
      try {
        const attempts = await persistence.commitAttempts(run.taskRunId);
        const report = { summary: run.appWorkflowOutcome?.summary ?? null, failure: null };
        await persistTerminal(
          persistence,
          run.taskRunId,
          decide(attempts, report, "shutdown"),
          attempts,
          options.dataVersionStore ?? defaultDataVersionStore,
        );
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}
