import type { AutomationTaskRow } from "./types.ts";

export type StructureReport = Readonly<{ taskId: string; text: string }>;
export type StructureReportNotice = "copied" | "copyFailed" | "openIssueFailed";

/**
 * The structure report of the failed run whose details are open. The dialog is open only for the
 * report it was opened on, so a report that resets or reloads never reopens it.
 */
export type StructureReportState = Readonly<{ key: string | null; report: StructureReport | null; open: boolean }>;

export const NO_STRUCTURE_REPORT: StructureReportState = { key: null, report: null, open: false };

/** One report per failed run: a new run of the same task asks again. */
export function structureReportKey(task: Pick<AutomationTaskRow, "id" | "latestFinishedAt"> | null): string | null {
  return task ? `${task.id}:${task.latestFinishedAt ?? ""}` : null;
}

/** Another run (or none) drops the report and closes its dialog; the same run keeps both. */
export function selectStructureReportRun(state: StructureReportState, key: string | null): StructureReportState {
  return key === state.key ? state : { key, report: null, open: false };
}

export function structureReportLoaded(
  state: StructureReportState,
  key: string,
  report: StructureReport | null,
): StructureReportState {
  return state.key === key && report ? { ...state, report } : state;
}

export function openStructureReport(state: StructureReportState): StructureReportState {
  return state.report ? { ...state, open: true } : state;
}

export function closeStructureReport(state: StructureReportState): StructureReportState {
  return { ...state, open: false };
}
