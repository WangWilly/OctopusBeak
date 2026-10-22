import type { AutomationRuntimeTaskSnapshot } from "$lib/desktop/api.ts";
import {
  canTransitionTaskRun,
  type ActiveTaskRunStatus,
  type AutomationPersistencePort,
  type AutomationTaskRun,
  type AutomationTaskRunUpdate,
} from "./store.ts";
import { runtimeTaskSnapshotFromRun } from "./runtime-state.ts";
import {
  decideAutomationTaskRunOutcome,
  finalizeAutomationTaskRun,
  type TaskRunStop,
} from "./task-run-finalization.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";
import type { CommitAttemptReport } from "../commit-attempt.ts";

export type ActiveTaskRunFields = Pick<AutomationTaskRunUpdate, "attempt" | "maxAttempts" | "progress">;

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
  /** Durably append one Commit attempt phase (ADR 0056). */
  recordCommitAttempt(report: CommitAttemptReport): Promise<void>;
  requestStop(reason: TaskRunStop): Promise<void>;
  /** Persist the terminal outcome. Later calls return the first result. */
  finish(report: TypedWorkflowOutcome): Promise<AutomationTaskRun>;
}>;

type RuntimeStatePort = Readonly<{
  upsert(task: AutomationRuntimeTaskSnapshot): unknown;
}>;

const STOP_RANK: Readonly<Record<TaskRunStop, number>> = { shutdown: 1, cancelled: 2, forced: 3 };

/** Ordinary cancellation gets this long to clean up before force-quit is offered. */
export const FORCE_QUIT_AVAILABLE_AFTER_MS = 10_000;

export function openActiveTaskRun(input: Readonly<{
  run: AutomationTaskRun;
  persistence: AutomationPersistencePort;
  runtime: RuntimeStatePort;
  forceQuitAvailableAfterMs?: number;
}>): ActiveAutomationTaskRun {
  const { persistence, runtime } = input;
  const taskRunId = input.run.taskRunId;
  const stopController = new AbortController();
  const forceController = new AbortController();
  let row = input.run;
  let stop: TaskRunStop | null = null;
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
    recordCommitAttempt: (report) => persistence.recordCommitAttempt(taskRunId, report),
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
    finish(report) {
      finishing ??= serialized(async () => {
        if (forceQuitTimer) clearTimeout(forceQuitTimer);
        row = await finalizeAutomationTaskRun(
          persistence,
          taskRunId,
          decideAutomationTaskRunOutcome(report, stop),
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
