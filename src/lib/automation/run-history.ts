import type { Locale } from "../i18n/i18n.ts";
import { taskLabel, taskLogo } from "./task-display.ts";
import type { AutomationTaskHistoryRow, AutomationTaskRow } from "./types.ts";

export type RunHistoryStatusGroup = "running" | "completed" | "failed";
export type RunHistoryFilter = "all" | RunHistoryStatusGroup;
export type RunHistoryCounts = Readonly<Record<RunHistoryStatusGroup, number>>;

export type RunHistoryLoad =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; rows: readonly AutomationTaskHistoryRow[] }>
  | Readonly<{ status: "failed" }>;

type HistoryTask = Pick<AutomationTaskRow, "id" | "displayName" | "credentialGroupId">;

export function historyStatusGroup(status: AutomationTaskHistoryRow["status"]): RunHistoryStatusGroup {
  if (status === "completed" || status === "partial") return "completed";
  if (status === "failed" || status === "locked") return "failed";
  return "running";
}

/** Minutes and seconds from start to finish, or to now while the run is still going. */
export function formatDuration(run: Pick<AutomationTaskHistoryRow, "startedAt" | "finishedAt">, now = new Date()): string {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now.getTime() : Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "--";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Runs of tasks the catalog no longer offers stay in the database but leave the history. */
export function filterHistoryToCurrentTasks(
  rows: readonly AutomationTaskHistoryRow[],
  tasks: readonly Pick<AutomationTaskRow, "id">[],
): AutomationTaskHistoryRow[] {
  const catalogTaskIds = new Set(tasks.map((task) => task.id));
  return rows.filter((run) => catalogTaskIds.has(run.taskId));
}

export function historyTaskLabel(tasks: readonly HistoryTask[], taskId: string, language: Locale): string {
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? taskLabel(task, language) : taskId;
}

export function historyTaskLogo(tasks: readonly HistoryTask[], taskId: string) {
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? taskLogo(task) : null;
}

export function visibleHistoryRows(
  rows: readonly AutomationTaskHistoryRow[],
  tasks: readonly HistoryTask[],
  filter: RunHistoryFilter,
  search: string,
  language: Locale,
): AutomationTaskHistoryRow[] {
  const term = search.trim().toLowerCase();
  return rows.filter((run) =>
    (filter === "all" || historyStatusGroup(run.status) === filter)
    && (!term || historyTaskLabel(tasks, run.taskId, language).toLowerCase().includes(term)));
}

export function historyCounts(rows: readonly AutomationTaskHistoryRow[]): RunHistoryCounts {
  const counts = { running: 0, completed: 0, failed: 0 };
  for (const run of rows) counts[historyStatusGroup(run.status)] += 1;
  return counts;
}
