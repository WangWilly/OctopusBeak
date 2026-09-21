import { randomUUID } from "node:crypto";
import type {
  AutomationRuntimeSnapshot,
  AutomationRuntimeStatementFailure,
  AutomationRuntimeTaskSnapshot,
  AutomationRuntimeTaskStatus,
} from "$lib/desktop/api.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type { AutomationTaskRun } from "./store.ts";
import { sanitizeAutomationLogTail } from "./log-sanitizer.ts";
import { assertKnownAutomationRuntimeTasks } from "../runtime-invariants.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import { parseStatementRunSummary } from "../statement-run-summary.ts";

export { sanitizeAutomationLogTail } from "./log-sanitizer.ts";

const RUNTIME_STATUSES = new Set<AutomationRuntimeTaskStatus>([
  "queued",
  "preparing",
  "running",
  "retrying",
  "waiting_for_human",
  "cancelling",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);

function isSafeProgress(value: unknown): value is AutomationTaskProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  const nullableNumber = (candidate: unknown) =>
    candidate === null || (typeof candidate === "number" && Number.isFinite(candidate));
  if (
    (progress.phaseCode !== null && typeof progress.phaseCode !== "string")
    || !nullableNumber(progress.completed)
    || !nullableNumber(progress.total)
    || !nullableNumber(progress.percent)
    || !Number.isSafeInteger(progress.attempt)
    || (typeof progress.percent === "number" && (progress.percent < 0 || progress.percent > 100))
  ) return false;
  if (progress.params === undefined) return true;
  if (!progress.params || typeof progress.params !== "object" || Array.isArray(progress.params)) return false;
  return Object.values(progress.params as Record<string, unknown>).every((param) =>
    typeof param === "string" || typeof param === "number" || typeof param === "boolean",
  );
}

function statementFailuresFromLogTail(logTail: string) {
  return parseStatementRunSummary(logTail)?.results
    .filter((result) => result.status === "failed")
    .map(({ typeId, error }) => ({
      typeId,
      ...(error ? { error: sanitizeAutomationLogTail(error) } : {}),
    })) ?? [];
}

export function assertAutomationRuntimeSnapshot(
  value: AutomationRuntimeSnapshot,
) {
  if (
    typeof value.sessionId !== "string"
    || !value.sessionId
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.tasks)
  ) {
    throw new Error("Invalid automation runtime snapshot.");
  }
  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    if (
      typeof task.taskId !== "string"
      || taskIds.has(task.taskId)
      || (task.runId !== null && typeof task.runId !== "string")
      || !RUNTIME_STATUSES.has(task.status)
      || !Number.isSafeInteger(task.attempt)
      || task.attempt < 0
      || !Number.isSafeInteger(task.maxAttempts)
      || task.maxAttempts < 1
      || (task.statementFailures !== undefined && !Array.isArray(task.statementFailures))
      || (task.statementFailures !== undefined && task.statementFailures.some((failure: AutomationRuntimeStatementFailure) =>
        !failure
        || typeof failure.typeId !== "string"
        || !failure.typeId
        || (failure.error !== undefined && typeof failure.error !== "string")
        || (failure.error !== undefined && failure.error !== sanitizeAutomationLogTail(failure.error))
      ))
      || typeof task.logTail !== "string"
      || Buffer.byteLength(task.logTail, "utf8") > 64 * 1024
      || task.logTail !== sanitizeAutomationLogTail(task.logTail)
      || !isSafeProgress(task.progress)
    ) {
      throw new Error("Invalid automation runtime task snapshot.");
    }
    taskIds.add(task.taskId);
  }
  return value;
}

function emptyProgress(attempt: number): AutomationTaskProgress {
  return {
    phaseCode: null,
    completed: null,
    total: null,
    percent: null,
    attempt,
  };
}

export function runtimeTaskSnapshotFromRun(
  run: Pick<AutomationTaskRun, "taskId" | "taskRunId" | "status" | "attempt" | "maxAttempts" | "logTail" | "errorMessage" | "progress">,
  status = run.status as AutomationRuntimeTaskStatus,
): AutomationRuntimeTaskSnapshot {
  const logTail = sanitizeAutomationLogTail(run.logTail);
  const baseProgress = run.progress ?? emptyProgress(run.attempt);
  const progress = status === "completed"
    ? {
        ...baseProgress,
        completed: 100,
        total: 100,
        percent: 100,
        attempt: run.attempt,
      }
    : baseProgress;
  return {
    taskId: run.taskId,
    runId: run.taskRunId,
    status,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    progress,
    statementFailures: statementFailuresFromLogTail(logTail),
    logTail,
    errorMessage: run.errorMessage === null
      ? null
      : sanitizeAutomationLogTail(run.errorMessage),
    updatedAt: new Date().toISOString(),
  };
}

export function createAutomationRuntimeState(
  sessionId = `automation-${randomUUID()}`,
  options: { knownTaskIds?: ReadonlySet<string> } = {},
) {
  let revision = 0;
  const tasks = new Map<string, AutomationRuntimeTaskSnapshot>();
  // A task's current run is a monotonic identity even though run IDs are
  // UUIDs. Once a run is replaced, late callbacks from that retired run must
  // never be allowed to replace the current progress/status record.
  const retiredRunIds = new Map<string, Set<string>>();
  const listeners = new Set<(snapshot: AutomationRuntimeSnapshot) => void>();

  const snapshot = (): AutomationRuntimeSnapshot => {
    const value = assertAutomationRuntimeSnapshot({
      sessionId,
      revision,
      tasks: [...tasks.values()],
    });
    if (options.knownTaskIds) {
      assertKnownAutomationRuntimeTasks(value, options.knownTaskIds);
    }
    return value;
  };

  const publish = () => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) {
      try { listener(next); } catch { /* observers cannot break lifecycle */ }
    }
    return next;
  };

  return {
    snapshot,
    upsert(task: AutomationRuntimeTaskSnapshot) {
      const current = tasks.get(task.taskId);
      const retired = retiredRunIds.get(task.taskId) ?? new Set<string>();
      if (current && task.runId !== current.runId) {
        if (
          (task.runId === null && current.runId !== null)
          || (task.runId !== null && retired.has(task.runId))
        ) return snapshot();
        if (current.runId !== null) retired.add(current.runId);
        retiredRunIds.set(task.taskId, retired);
      }
      tasks.set(task.taskId, {
        ...task,
        logTail: sanitizeAutomationLogTail(task.logTail),
      });
      return publish();
    },
    remove(taskId: string) {
      if (!tasks.delete(taskId)) return snapshot();
      return publish();
    },
    subscribe(listener: (snapshot: AutomationRuntimeSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      tasks.clear();
      retiredRunIds.clear();
      return publish();
    },
  };
}

const automationTaskIds = new Set(AUTOMATION_TASKS.map((task) => task.id));

/** The main-process singleton validates the active-task catalog before every snapshot/publication. */
export const automationRuntimeState = createAutomationRuntimeState(
  undefined,
  { knownTaskIds: automationTaskIds },
);
