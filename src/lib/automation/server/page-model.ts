import type { AutomationTask } from "./tasks.ts";
import type { AutomationTaskRun } from "./store.ts";
import type { AutomationTaskStatus } from "../types.ts";
import type { WorkflowStage } from "../workflow-executor.ts";
import { hasValidRunEventMeaning, type WorkflowRunEvent } from "../run-event.ts";
import type {
  AutomationPageModel,
  AutomationTaskPrerequisiteNotice,
  AutomationTaskRow,
} from "../types.ts";
import type { AutomationRuntimeSnapshot } from "$lib/desktop/api.ts";
import {
  applyAutomationRuntime,
  automationRowPercent,
  automationRowStatus,
  awaitsCanonicalReset,
  automationTaskRowActions,
  isActiveAutomationRuntimeStatus,
  isWorkflowStage,
  parallelRunnableAutomationTaskIds,
} from "../task-row.ts";

const MAX_WORKFLOW_EVENTS = 200;
const SAFE_WORKFLOW_EVENT_CODE = /^[a-z][a-z0-9-]{0,63}$/u;

/** Project persisted values onto the renderer-safe event contract. */
function pageWorkflowEvents(
  value: unknown,
  runId: string | undefined,
): readonly WorkflowRunEvent[] {
  if (!Array.isArray(value) || !runId) return [];
  return value.flatMap((candidate): WorkflowRunEvent[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const event = candidate as Record<string, unknown>;
    if (
      event.runId !== runId
      || typeof event.stage !== "string"
      || !isWorkflowStage(event.stage)
      || typeof event.code !== "string"
      || !SAFE_WORKFLOW_EVENT_CODE.test(event.code)
      || !hasValidRunEventMeaning(event)
      || typeof event.occurredAt !== "string"
      || !Number.isFinite(Date.parse(event.occurredAt))
      || (event.completed !== undefined
        && (!Number.isSafeInteger(event.completed) || (event.completed as number) < 0))
      || (event.total !== undefined
        && (!Number.isSafeInteger(event.total) || (event.total as number) < 0))
    ) return [];
    return [{
      runId,
      stage: event.stage as WorkflowStage,
      outcome: event.outcome as WorkflowRunEvent["outcome"],
      code: event.code,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
      occurredAt: event.occurredAt,
      ...(event.completed === undefined ? {} : { completed: event.completed as number }),
      ...(event.total === undefined ? {} : { total: event.total as number }),
    } as WorkflowRunEvent];
  }).slice(-MAX_WORKFLOW_EVENTS);
}

function rowStatus(
  run: AutomationTaskRun | undefined,
  isActive: boolean,
) {
  if (run?.appWorkflowOutcome?.errorCode === "cancelled") return "cancelled";
  if (run?.appWorkflowOutcome?.errorCode) return "failed";
  if (run?.status === "waiting_for_human") return "waiting_for_human";
  if (isActive) return "running";
  if (run?.status === "running") return "failed";
  return run?.status ?? "queued";
}

export function buildAutomationPageModel(input: {
  tasks: readonly AutomationTask[];
  latestRuns: Record<string, AutomationTaskRun>;
  activeTaskIds?: readonly string[];
  todayRunTaskIds?: readonly string[];
  credentials: Record<string, boolean>;
  setupRequiredGroupIds?: ReadonlySet<string>;
  /** Integration namespaces the store refuses until a Canonical Reset. */
  canonicalResetRequiredNamespaces?: ReadonlySet<string>;
  externalPrerequisiteNotices?: readonly AutomationTaskPrerequisiteNotice[];
  active: boolean;
  businessDate: string;
  runtime?: AutomationRuntimeSnapshot;
  credentialStates?: Record<string, "loading" | "ready" | "missing" | "read_failed">;
}): AutomationPageModel {
  const activeTaskIds = new Set(input.activeTaskIds ?? []);
  const todayRunTaskIds = new Set(input.todayRunTaskIds ?? []);
  const setupRequiredGroupIds = input.setupRequiredGroupIds ?? new Set<string>();
  const resetRequiredNamespaces = input.canonicalResetRequiredNamespaces ?? new Set<string>();
  const tasks = input.tasks.map((task) => {
    const run = input.latestRuns[task.id];
    const runtime = input.runtime?.tasks.find((candidate) => candidate.taskId === task.id);
    const isActive = activeTaskIds.has(task.id);
    const setupRequired = Boolean(task.credentialGroupId && setupRequiredGroupIds.has(task.credentialGroupId));
    const canonicalResetRequired = task.integrationNamespaces.some((namespace) => resetRequiredNamespaces.has(namespace));
    const latestRunStatus = rowStatus(run, isActive);
    const status = automationRowStatus(
      latestRunStatus,
      isActive,
      setupRequired,
      awaitsCanonicalReset(canonicalResetRequired, run?.appWorkflowOutcome ?? null),
    );
    const credentialsReady = task.credentialKeys.every((key) =>
      (input.credentialStates?.[key] ?? (input.credentials[key] ? "ready" : "missing")) === "ready",
    );
    const progressPercent = automationRowPercent(status, run?.progress?.percent ?? null);
    const attempt = run?.attempt ?? 0;
    const maxAttempts = run?.maxAttempts ?? task.maxAttempts;
    const persisted = {
      id: task.id,
      runId: run?.taskRunId ?? null,
      label: task.label,
      displayName: task.displayName,
      kind: task.kind,
      credentialGroupId: task.credentialGroupId,
      integrationNamespaces: task.integrationNamespaces,
      credentialKeys: task.credentialKeys,
      dependencies: task.dependencies,
      externalPrerequisites: task.externalPrerequisites,
      status,
      latestRunStatus,
      attempt,
      maxAttempts,
      latestStartedAt: run?.startedAt ?? null,
      latestFinishedAt: run?.finishedAt ?? null,
      workflowProgress: run?.progress ? { ...run.progress, percent: progressPercent } : null,
      appWorkflowOutcome: run?.appWorkflowOutcome ?? null,
      events: pageWorkflowEvents(run?.events, run?.taskRunId),
      progressPercent,
      humanSession: null,
      humanAssistanceContract: run?.humanAssistanceContract ?? null,
      forceTerminateAvailable: false,
      isActive,
      ranToday: todayRunTaskIds.has(task.id),
      credentialsReady,
      setupRequired,
      canonicalResetRequired,
      ...automationTaskRowActions(status, isActive, credentialsReady),
    } satisfies AutomationTaskRow;
    const row = runtime ? applyAutomationRuntime(persisted, runtime) : persisted;
    return {
      ...row,
      humanSession: row.status === "waiting_for_human"
        && task.workflowId
        && task.kind === "crawler"
        ? run?.taskRunId ?? runtime?.runId ?? null
        : null,
    } satisfies AutomationTaskRow;
  });
  return {
    businessDate: input.businessDate,
    active: input.active || activeTaskIds.size > 0 || Boolean(input.runtime?.tasks.some((task) =>
      isActiveAutomationRuntimeStatus(task.status))),
    activeTaskCount: input.runtime?.tasks.filter((task) =>
      isActiveAutomationRuntimeStatus(task.status),
    ).length ?? activeTaskIds.size,
    parallelRunnableTaskIds: parallelRunnableAutomationTaskIds(tasks),
    credentials: input.credentials,
    credentialStates: input.credentialStates,
    externalPrerequisiteNotices: [...(input.externalPrerequisiteNotices ?? [])],
    tasks,
  };
}
