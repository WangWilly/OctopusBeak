import type {
  AutomationRuntimeBlockVersion,
  AutomationRuntimeSnapshot,
  AutomationRuntimeTaskSnapshot,
} from "../desktop/api.ts";
import { isActiveAutomationRuntimeStatus } from "./runtime-status.ts";
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";
import type { AutomationActionToken } from "./runtime-controller.ts";
import { primaryActionForAutomationTask } from "./primary-action.ts";

/** A block's captured runtime version, or null for legacy/fallback models. */
export function automationBlockRuntimeVersion(
  value: Partial<AutomationRuntimeBlockVersion> | null | undefined,
): AutomationRuntimeBlockVersion | null {
  const revision = value?.runtimeRevision;
  if (
    !value
    || typeof value.runtimeSessionId !== "string"
    || !value.runtimeSessionId
    || typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) return null;
  return {
    runtimeSessionId: value.runtimeSessionId,
    runtimeRevision: revision,
  };
}

/**
 * A block is stale only when its captured snapshot belongs to this session
 * and is older than the runtime snapshot currently held by the shell.  A
 * session mismatch is handled by the shell's authoritative resync path.
 */
export function isAutomationBlockStale(
  blockVersion: Partial<AutomationRuntimeBlockVersion> | null | undefined,
  current: AutomationRuntimeSnapshot | null | undefined,
): boolean {
  const version = automationBlockRuntimeVersion(blockVersion);
  if (!version || !current || version.runtimeSessionId !== current.sessionId) return false;
  return version.runtimeRevision < current.revision;
}

function progressText(
  task: AutomationTaskRow,
  runtime: AutomationRuntimeTaskSnapshot,
  percent: number | null = runtime.progress.percent,
) {
  if (percent !== null) return `${percent}%`;
  if (runtime.status === "running") return `Running attempt ${runtime.attempt}/${runtime.maxAttempts}`;
  if (runtime.status === "retrying") return `Retrying attempt ${runtime.attempt}/${runtime.maxAttempts}`;
  if (runtime.status === "waiting_for_human") return "Waiting for human";
  if (runtime.status === "completed") return "Completed";
  if (runtime.status === "partial") return "Partial";
  if (runtime.status === "failed") return "Failed";
  if (runtime.status === "cancelled") return "Cancelled";
  if (runtime.status === "interrupted") return "Interrupted";
  return task.progressText;
}

function applyOptimisticAction(
  task: AutomationTaskRow,
  action: AutomationActionToken,
): AutomationTaskRow {
  if (action.kind === "run") {
    return {
      ...task,
      runId: null,
      status: "preparing",
      isActive: true,
      primaryAction: "Cancel",
      canRun: true,
      attempt: 1,
      latestStartedAt: null,
      latestFinishedAt: null,
      appWorkflowOutcome: null,
      events: [],
      progressPercent: 0,
      progressText: "Preparing",
      workflowProgress: null,
      humanSession: null,
      humanAssistanceContract: null,
    };
  }
  return {
    ...task,
    status: "cancelling",
    isActive: true,
    primaryAction: "Cancel",
    canRun: true,
  };
}

/** Merge one authoritative runtime record without mutating block data. */
export function mergeAutomationRuntimeTask(
  task: AutomationTaskRow,
  runtime: AutomationRuntimeTaskSnapshot,
): AutomationTaskRow {
  const isActive = isActiveAutomationRuntimeStatus(runtime.status);
  const status = runtime.status as AutomationTaskRow["status"];
  const isSameRun = runtime.runId !== null && task.runId === runtime.runId;
  const observedPercent = isSameRun && task.progressPercent !== null
    ? Math.max(task.progressPercent, runtime.progress.percent ?? task.progressPercent)
    : runtime.progress.percent;
  const progressPercent = status === "completed"
    ? 100
    : observedPercent === null
      ? null
      : Math.min(99, observedPercent);
  const workflowProgress = {
    ...runtime.progress,
    percent: progressPercent,
  };
  return {
    ...task,
    runId: runtime.runId,
    status,
    isActive,
    attempt: runtime.attempt,
    maxAttempts: runtime.maxAttempts,
    workflowProgress,
    appWorkflowOutcome: runtime.appWorkflowOutcome,
    forceTerminateAvailable: runtime.forceTerminateAvailable === true,
    progressPercent,
    progressText: progressText(task, runtime, progressPercent),
    primaryAction: primaryActionForAutomationTask(status, isActive),
    // Active lifecycle always wins over credential readiness so a run can be
    // cancelled/terminated even if credentials are being refreshed.
    canRun: isActive || task.canRun,
  };
}

/**
 * Pure selector used by every automation block consumer.  The block remains
 * the source of static/credential metadata while the shell runtime snapshot
 * owns every live task field.
 */
export function mergeAutomationRuntime(
  source: AutomationPageModel,
  runtime: AutomationRuntimeSnapshot | null | undefined,
  pendingActions: readonly AutomationActionToken[] = [],
): AutomationPageModel {
  if (!runtime && pendingActions.length === 0) return source;
  const byTaskId = new Map(runtime?.tasks.map((task) => [task.taskId, task]) ?? []);
  const optimisticByTaskId = new Map(pendingActions.map((action) => [action.taskId, action]));
  const tasks = source.tasks.map((task) => {
    const live = byTaskId.get(task.id);
    const merged = live ? mergeAutomationRuntimeTask(task, live) : task;
    const optimistic = optimisticByTaskId.get(task.id);
    return optimistic ? applyOptimisticAction(merged, optimistic) : merged;
  });
  const activeTaskCount = (runtime?.tasks ?? []).filter((task) =>
    isActiveAutomationRuntimeStatus(task.status),
  ).length + tasks.filter((task) =>
    !byTaskId.has(task.id) && task.isActive,
  ).length;
  return {
    ...source,
    active: activeTaskCount > 0,
    activeTaskCount,
    tasks,
    parallelRunnableTaskIds: tasks
      .filter((task) => task.canRun && !task.isActive && task.primaryAction !== "Configure" && task.primaryAction !== "Locked")
      .map((task) => task.id),
  };
}

export function selectAutomationBlockModel(
  fallback: AutomationPageModel,
  block: AutomationPageModel | undefined,
  runtime: AutomationRuntimeSnapshot | null | undefined,
  pendingActions: readonly AutomationActionToken[] = [],
): AutomationPageModel {
  return mergeAutomationRuntime(block ?? fallback, runtime, pendingActions);
}
