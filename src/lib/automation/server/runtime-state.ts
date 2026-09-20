import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  AutomationRuntimeSnapshot,
  AutomationRuntimeTaskSnapshot,
  AutomationRuntimeTaskStatus,
} from "$lib/desktop/api.ts";
import type { AutomationTaskProgress } from "../types.ts";
import type { AutomationTaskRun } from "./store.ts";

const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 64 * 1024;

export function sanitizeAutomationLogTail(value: string) {
  const redacted = stripVTControlCharacters(value)
    .replace(/((?:password|passwd|token|secret|authorization|cookie|otp|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  const lines = redacted.split(/\r?\n/).slice(-MAX_LOG_LINES);
  let output = lines.join("\n");
  while (Buffer.byteLength(output, "utf8") > MAX_LOG_BYTES) {
    const firstBreak = output.indexOf("\n");
    if (firstBreak < 0) {
      output = output.slice(-MAX_LOG_BYTES);
      break;
    }
    output = output.slice(firstBreak + 1);
  }
  return output;
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
    errorMessage: run.errorMessage,
    updatedAt: new Date().toISOString(),
  };
}

export function createAutomationRuntimeState(
  sessionId = `automation-${randomUUID()}`,
) {
  let revision = 0;
  const tasks = new Map<string, AutomationRuntimeTaskSnapshot>();
  const listeners = new Set<(snapshot: AutomationRuntimeSnapshot) => void>();

  const snapshot = (): AutomationRuntimeSnapshot => ({
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
