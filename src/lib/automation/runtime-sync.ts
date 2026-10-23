import type {
  AutomationRuntimeBlockVersion,
  AutomationRuntimeSnapshot,
} from "../desktop/api.ts";
import type { AutomationPageModel } from "./types.ts";
import type { AutomationActionToken } from "./runtime-controller.ts";
import {
  applyAutomationRuntime,
  applyOptimisticAutomationAction,
  isActiveAutomationRuntimeStatus,
  parallelRunnableAutomationTaskIds,
} from "./task-row.ts";

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
    const merged = live ? applyAutomationRuntime(task, live) : task;
    const optimistic = optimisticByTaskId.get(task.id);
    return optimistic ? applyOptimisticAutomationAction(merged, optimistic.kind) : merged;
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
    parallelRunnableTaskIds: parallelRunnableAutomationTaskIds(tasks),
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
