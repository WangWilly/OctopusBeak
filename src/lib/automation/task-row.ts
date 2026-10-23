import type { AutomationRuntimeTaskSnapshot } from "../desktop/api.ts";
import type { AutomationTaskRow, AutomationTaskStatus } from "./types.ts";
import type { AutomationActionToken } from "./runtime-controller.ts";

/**
 * The lifecycle rules of one Automation task row, shared by the App's page
 * model and the renderer's runtime merge.  Display copy lives in the
 * renderer; nothing here reads a dictionary.
 */

export const ACTIVE_AUTOMATION_STATUSES = [
  "queued",
  "preparing",
  "running",
  "waiting_for_human",
  "cancelling",
] as const satisfies readonly AutomationTaskStatus[];

export const TERMINAL_AUTOMATION_STATUSES = [
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly AutomationTaskStatus[];

export type ActiveAutomationRuntimeStatus = (typeof ACTIVE_AUTOMATION_STATUSES)[number];
export type TerminalAutomationStatus = (typeof TERMINAL_AUTOMATION_STATUSES)[number];

const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_AUTOMATION_STATUSES);
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_AUTOMATION_STATUSES);

export function isActiveAutomationRuntimeStatus(status: string): status is ActiveAutomationRuntimeStatus {
  return ACTIVE.has(status);
}

export function isTerminalAutomationStatus(status: string): status is TerminalAutomationStatus {
  return TERMINAL.has(status);
}

type RowActions = Pick<AutomationTaskRow, "primaryAction" | "canRun">;

/** The primary action and whether it is enabled, from the authoritative lifecycle status. */
export function automationTaskRowActions(
  status: AutomationTaskStatus,
  isActive: boolean,
  credentialsReady: boolean,
): RowActions {
  const primaryAction = isActive || status === "waiting_for_human"
    ? "Cancel"
    : status === "needs_setup"
      ? "Configure"
      : status === "locked"
        ? "Locked"
        : status === "failed"
          ? "Run again"
          : "Run";
  // Active lifecycle always wins over credential readiness so a run can be
  // cancelled/terminated even if credentials are being refreshed.
  const canRun = primaryAction === "Cancel" || (!isActive && primaryAction !== "Locked" && credentialsReady);
  return { primaryAction, canRun };
}

/** A run's percent as a row shows it: 100 only once completed, otherwise capped at 99. */
export function automationRowPercent(status: AutomationTaskStatus, percent: number | null): number | null {
  if (status === "completed") return 100;
  return percent === null ? null : Math.min(99, percent);
}

/** Overlay one authoritative runtime record on a row without mutating it. */
export function applyAutomationRuntime(
  row: AutomationTaskRow,
  runtime: AutomationRuntimeTaskSnapshot,
): AutomationTaskRow {
  const isActive = isActiveAutomationRuntimeStatus(runtime.status);
  const status = runtime.status as AutomationTaskStatus;
  const isSameRun = runtime.runId !== null && row.runId === runtime.runId;
  // Progress never moves backwards within one run.
  const observedPercent = isSameRun && row.progressPercent !== null
    ? Math.max(row.progressPercent, runtime.progress.percent ?? row.progressPercent)
    : runtime.progress.percent;
  const progressPercent = automationRowPercent(status, observedPercent);
  return {
    ...row,
    runId: runtime.runId,
    status,
    isActive,
    attempt: runtime.attempt,
    maxAttempts: runtime.maxAttempts,
    workflowProgress: { ...runtime.progress, percent: progressPercent },
    appWorkflowOutcome: runtime.appWorkflowOutcome,
    forceTerminateAvailable: runtime.forceTerminateAvailable === true,
    progressPercent,
    ...automationTaskRowActions(status, isActive, row.credentialsReady),
  };
}

/** The row a person sees between pressing an action and the runtime acknowledging it. */
export function applyOptimisticAutomationAction(
  row: AutomationTaskRow,
  kind: AutomationActionToken["kind"],
): AutomationTaskRow {
  if (kind === "run") {
    return {
      ...row,
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
      workflowProgress: null,
      humanSession: null,
      humanAssistanceContract: null,
    };
  }
  return {
    ...row,
    status: "cancelling",
    isActive: true,
    primaryAction: "Cancel",
    canRun: true,
  };
}

/** The tasks Sync all may start together: runnable, idle, and fully configured. */
export function parallelRunnableAutomationTaskIds(rows: readonly AutomationTaskRow[]): string[] {
  return rows
    .filter((row) =>
      row.canRun
      && !row.isActive
      && row.credentialsReady
      && row.primaryAction !== "Cancel"
      && row.primaryAction !== "Configure"
      && row.primaryAction !== "Locked")
    .map((row) => row.id);
}
