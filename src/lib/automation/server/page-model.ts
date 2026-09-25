import type { AutomationTask } from "./tasks.ts";
import type { AutomationTaskRun } from "./store.ts";
import type { AutomationTaskStatus } from "../types.ts";
import type { WorkflowRunEvent, WorkflowStage } from "../workflow-executor.ts";
import type {
  AutomationPageModel,
  AutomationTaskPrerequisiteNotice,
  AutomationTaskRow,
} from "../types.ts";
import { isActiveAutomationRuntimeStatus } from "../runtime-status.ts";
import type { AutomationRuntimeSnapshot } from "$lib/desktop/api.ts";
import { parseStatementRunSummary } from "../statement-run-summary.ts";
import { resumeFailureMessage } from "./runner.ts";
import { primaryActionForAutomationTask } from "../primary-action.ts";

const workflowStages = new Set<WorkflowStage>([
  "preparation",
  "authentication",
  "collection",
  "decoding",
  "validation",
  "commit",
  "finalization",
]);
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
      || !workflowStages.has(event.stage as WorkflowStage)
      || typeof event.code !== "string"
      || !SAFE_WORKFLOW_EVENT_CODE.test(event.code)
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
      code: event.code,
      occurredAt: event.occurredAt,
      ...(event.completed === undefined ? {} : { completed: event.completed as number }),
      ...(event.total === undefined ? {} : { total: event.total as number }),
    }];
  }).slice(-MAX_WORKFLOW_EVENTS);
}

function rowStatus(
  task: AutomationTask,
  run: AutomationTaskRun | undefined,
  isActive: boolean,
  setupRequiredGroupIds: ReadonlySet<string>,
) {
  if (run && resumeFailureMessage(run.logTail)) return "failed";
  if (run?.status === "waiting_for_human") return "waiting_for_human";
  if (isActive) return run?.status === "retrying" ? "retrying" : "running";
  if (task.credentialGroupId && setupRequiredGroupIds.has(task.credentialGroupId)) return "needs_setup";
  if (
    run &&
    (run.status === "running" || run.status === "retrying")
  ) {
    return "failed";
  }
  return run?.status ?? "queued";
}

function progressText(status: AutomationTaskStatus, attempt: number, maxAttempts: number, progress: number | null) {
  if (progress !== null) return `${progress}%`;
  if (status === "running") return `Running attempt ${attempt}/${maxAttempts}`;
  if (status === "retrying") return `Retrying attempt ${attempt}/${maxAttempts}`;
  if (status === "waiting_for_human") return "Waiting for human";
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "needs_setup") return "Needs setup";
  if (status === "failed") return "Failed";
  if (status === "locked") return "Locked";
  return "Queued";
}

export function buildAutomationPageModel(input: {
  tasks: readonly AutomationTask[];
  latestRuns: Record<string, AutomationTaskRun>;
  activeTaskIds?: readonly string[];
  todayRunTaskIds?: readonly string[];
  credentials: Record<string, boolean>;
  setupRequiredGroupIds?: ReadonlySet<string>;
  externalPrerequisiteNotices?: readonly AutomationTaskPrerequisiteNotice[];
  active: boolean;
  businessDate: string;
  runtime?: AutomationRuntimeSnapshot;
  credentialStates?: Record<string, "loading" | "ready" | "missing" | "read_failed">;
}): AutomationPageModel {
  const activeTaskIds = new Set(input.activeTaskIds ?? []);
  const todayRunTaskIds = new Set(input.todayRunTaskIds ?? []);
  const setupRequiredGroupIds = input.setupRequiredGroupIds ?? new Set<string>();
  const tasks = input.tasks.map((task) => {
    const run = input.latestRuns[task.id];
    const runtime = input.runtime?.tasks.find((candidate) => candidate.taskId === task.id);
    const isActive = runtime
      ? isActiveAutomationRuntimeStatus(runtime.status)
      : activeTaskIds.has(task.id);
    const status = runtime?.status ?? rowStatus(task, run, isActive, setupRequiredGroupIds);
    const action = primaryActionForAutomationTask(status, isActive);
    const credentialsReady = task.credentialKeys.every((key) =>
      (input.credentialStates?.[key] ?? (input.credentials[key] ? "ready" : "missing")) === "ready",
    );
    const progressPercent = runtime?.progress.percent ?? run?.progress?.percent ?? null;
    const attempt = runtime?.attempt ?? run?.attempt ?? 0;
    const maxAttempts = runtime?.maxAttempts ?? run?.maxAttempts ?? task.maxAttempts;
    const events = pageWorkflowEvents(run?.events, run?.taskRunId);
    const statementFailures = parseStatementRunSummary(run?.logTail ?? "")?.results
      .filter((result) => result.status === "failed")
      .map(({ typeId, error }) => ({ typeId, ...(error ? { error } : {}) })) ?? [];
    return {
      id: task.id,
      runId: runtime?.runId ?? run?.taskRunId ?? null,
      label: task.label,
      script: task.script,
      kind: task.kind,
      credentialGroupId: task.credentialGroupId,
      credentialKeys: task.credentialKeys,
      dependencies: task.dependencies,
      externalPrerequisites: task.externalPrerequisites,
      status,
      attempt,
      maxAttempts,
      latestStartedAt: run?.startedAt ?? null,
      latestFinishedAt: run?.finishedAt ?? null,
      logTail: runtime?.logTail ?? run?.logTail ?? "",
      errorMessage: runtime?.errorMessage ?? run?.errorMessage ?? null,
      logPath: run?.logPath ?? null,
      eventDisplayMode: task.workflowId || events.length > 0 ? "structured" : "legacy",
      events,
      progressPercent,
      progressText: progressText(status, attempt, maxAttempts, progressPercent),
      statementFailures,
      humanSession: status === "waiting_for_human"
        && task.workflowId
        && events.length > 0
        ? run?.taskRunId ?? runtime?.runId ?? null
        : null,
      humanAssistanceContract: run?.humanAssistanceContract ?? null,
      forceTerminateAvailable: runtime?.forceTerminateAvailable === true,
      isActive,
      ranToday: todayRunTaskIds.has(task.id),
      primaryAction: action,
      canRun: action === "Cancel" || (!isActive && action !== "Locked" && credentialsReady),
    } satisfies AutomationTaskRow;
  });
  return {
    businessDate: input.businessDate,
    active: input.active || activeTaskIds.size > 0 || Boolean(input.runtime?.tasks.some((task) =>
      isActiveAutomationRuntimeStatus(task.status))),
    activeTaskCount: input.runtime?.tasks.filter((task) =>
      isActiveAutomationRuntimeStatus(task.status),
    ).length ?? activeTaskIds.size,
    parallelRunnableTaskIds: tasks
      .filter((task) =>
        task.canRun
        && task.primaryAction !== "Cancel"
        && task.primaryAction !== "Configure"
        && !task.isActive
        && task.credentialKeys.every((key) => input.credentials[key])
      )
      .map((task) => task.id),
    credentials: input.credentials,
    credentialStates: input.credentialStates,
    externalPrerequisiteNotices: [...(input.externalPrerequisiteNotices ?? [])],
    tasks,
  };
}
