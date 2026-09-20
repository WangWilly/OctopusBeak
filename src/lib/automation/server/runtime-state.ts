import { randomUUID } from "node:crypto";
import type {
  AutomationRuntimeSnapshot,
  AutomationRuntimeTaskSnapshot,
  AutomationRuntimeTaskStatus,
} from "$lib/desktop/api.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type { AutomationTaskRun } from "./store.ts";
import { sanitizeAutomationLogTail } from "./log-sanitizer.ts";

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
    logTail,
    errorMessage: run.errorMessage === null
      ? null
      : sanitizeAutomationLogTail(run.errorMessage),
    updatedAt: new Date().toISOString(),
  };
}

export function createAutomationRuntimeState(
  sessionId = `automation-${randomUUID()}`,
) {
  let revision = 0;
  const tasks = new Map<string, AutomationRuntimeTaskSnapshot>();
  const listeners = new Set<(snapshot: AutomationRuntimeSnapshot) => void>();

  const snapshot = (): AutomationRuntimeSnapshot => assertAutomationRuntimeSnapshot({
    sessionId,
    revision,
    tasks: [...tasks.values()],
  });

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
      return publish();
    },
  };
}

export const automationRuntimeState = createAutomationRuntimeState();
