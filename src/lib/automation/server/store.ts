import type {
  AutomationTaskKind,
  AutomationTaskProgress,
  AutomationTaskStatus,
} from "../types.ts";
import {
  type HumanAssistanceContract,
  type HumanAssistanceContractInput,
  type HumanAssistanceCompletionStatus,
} from "../human-assistance.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";

export type { AutomationTaskKind, AutomationTaskStatus } from "../types.ts";

export type AutomationTaskRun = {
  taskRunId: string;
  taskId: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  events: readonly WorkflowRunEvent[];
  progress?: AutomationTaskProgress;
  terminationMode?: "forced";
  recordJson: string;
  humanAssistanceContract: HumanAssistanceContract | null;
  /** App-owned typed outcome retained in record_json, if this was a typed run. */
  appWorkflowOutcome?: TypedWorkflowOutcome | null;
  /** Canonical schedule occurrence identity, persisted in record_json. */
  scheduledAtUtc?: string;
};

export type AutomationTaskHistoryRow = Pick<
  AutomationTaskRun,
  | "taskRunId"
  | "taskId"
  | "kind"
  | "status"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "signal"
> & {
  /** Null for legacy runs without an App typed outcome. */
  appWorkflowOutcome: TypedWorkflowOutcome | null;
};

export type AutomationTaskPrerequisiteNoticeRecord = {
  noticeId: string;
  taskId: string;
  prerequisiteId: string;
  latestTaskRunId: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  latestErrorMessage: string | null;
  resolvedAt: string | null;
  resolvedByTaskRunId: string | null;
  recordJson: string;
};

export type CreateTaskRunInput = {
  taskId: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  progress?: AutomationTaskProgress;
  humanAssistanceContract?: HumanAssistanceContract | null;
  scheduledAtUtc?: string;
};

/** Async persistence contract implemented by the worker-owned PGlite store. */
export interface AutomationPersistencePort {
  createTaskRun(input: CreateTaskRunInput): Promise<{ taskRunId: string }>;
  updateTaskRun(taskRunId: string, update: AutomationTaskRunUpdate): Promise<void>;
  transitionTaskRunToActive(
    taskRunId: string,
    update: AutomationTaskRunActiveUpdate,
  ): Promise<{ status: AutomationTaskStatus; applied: boolean }>;
  transitionTaskRunToTerminal(
    taskRunId: string,
    update: AutomationTaskRunTerminalUpdate,
  ): Promise<{ status: AutomationTaskStatus; applied: boolean }>;
  updateHumanAssistanceContract(
    taskRunId: string,
    input: HumanAssistanceContractInput,
  ): Promise<HumanAssistanceContract>;
  updateHumanAssistanceCompletion(
    taskRunId: string,
    status: HumanAssistanceCompletionStatus,
  ): Promise<HumanAssistanceContract>;
  taskRunById(taskRunId: string): Promise<AutomationTaskRun | null>;
  activeTaskRuns(): Promise<AutomationTaskRun[]>;
  latestTaskRuns(): Promise<Record<string, AutomationTaskRun>>;
  todayTaskRunIds(input: { startUtc: Date; endUtc: Date }): Promise<string[]>;
  hasSuccessfulTaskRunSince(taskId: string, occurrence: string): Promise<boolean>;
  hasOccurrenceBeenAttempted(taskId: string, occurrenceUtc: string): Promise<boolean>;
  recentTaskRuns(limit?: number): Promise<AutomationTaskHistoryRow[]>;
  appendRunEvent(event: WorkflowRunEvent): Promise<void>;
  pruneRunEvents(cutoffUtc: string): Promise<number>;
  upsertTaskPrerequisiteNotice(input: {
    taskId: string;
    prerequisiteId: string;
    taskRunId: string;
    detectedAt: string;
    errorMessage?: string | null;
  }): Promise<void>;
  activeTaskPrerequisiteNotices(): Promise<AutomationTaskPrerequisiteNoticeRecord[]>;
  allTaskPrerequisiteNotices(): Promise<AutomationTaskPrerequisiteNoticeRecord[]>;
  resolveTaskPrerequisiteNotices(
    taskId: string,
    resolvedByTaskRunId: string,
    resolvedAt: string,
  ): Promise<void>;
}

/** Shared injection object for domain boundaries during the PGlite cutover. */
export type AutomationPersistenceProvider = Readonly<{
  automation: AutomationPersistencePort;
}>;

export function createAutomationPersistenceProvider(
  automation: AutomationPersistencePort,
): AutomationPersistenceProvider {
  return Object.freeze({ automation });
}

export type AutomationTaskRunUpdate = Partial<
  Pick<
    AutomationTaskRun,
    | "status"
    | "attempt"
    | "maxAttempts"
    | "finishedAt"
    | "exitCode"
    | "signal"
    | "progress"
    | "terminationMode"
    | "humanAssistanceContract"
    | "appWorkflowOutcome"
  >
>;

export const ACTIVE_TASK_RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "retrying",
  "cancelling",
  "waiting_for_human",
] as const;

export const TERMINAL_TASK_RUN_STATUSES = [
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type ActiveTaskRunStatus = (typeof ACTIVE_TASK_RUN_STATUSES)[number];
export type TerminalTaskRunStatus = (typeof TERMINAL_TASK_RUN_STATUSES)[number];

export type AutomationTaskRunActiveUpdate = AutomationTaskRunUpdate & {
  status: ActiveTaskRunStatus;
};

export type AutomationTaskRunTerminalUpdate = AutomationTaskRunUpdate & {
  status: TerminalTaskRunStatus;
};

export function isActiveTaskRunStatus(
  status: AutomationTaskStatus,
): status is ActiveTaskRunStatus {
  return ACTIVE_TASK_RUN_STATUSES.includes(status as ActiveTaskRunStatus);
}

export function isTerminalTaskRunStatus(
  status: AutomationTaskStatus,
): status is TerminalTaskRunStatus {
  return TERMINAL_TASK_RUN_STATUSES.includes(status as TerminalTaskRunStatus);
}

/**
 * A resumed workflow must re-publish any assistance stage it still needs.
 * An entered/verified contract belongs to the preceding pause and must not
 * describe a later pause if the workflow reaches another human boundary.
 */
export function resumeHumanAssistanceContract(
  contract: HumanAssistanceContract | null | undefined,
): HumanAssistanceContract | null {
  return contract?.completion.status === "pending" ? contract : null;
}
