import { isTerminalAutomationStatus } from "./task-row.ts";
import type { AutomationTaskRow } from "./types.ts";

/** Runs that finished this long before the newest one belong to an earlier sync. */
const SAME_SYNC_MS = 12 * 60 * 60 * 1000;

/** What the Automation header says between runs: how the latest sync's runs ended, and when. */
export type LastSyncSummary = Readonly<{
  completed: number;
  /** Runs of that sync that ended any other way: partial, failed, cancelled, interrupted. */
  unfinished: number;
  /** The newest finish among them. */
  finishedAt: string;
}>;

type SummaryTask = Pick<AutomationTaskRow, "latestRunStatus" | "latestFinishedAt" | "credentialGroupId">;

/**
 * Only sources count: the exchange-rate task runs on its own schedule and has
 * no sign-in details. A row's latest run counts even when the row now asks
 * for setup. Runs that finished long before the newest one are an older sync,
 * so a failure from weeks ago is not shown as today's. Null until a source
 * has finished a run.
 */
export function lastSyncSummary(tasks: readonly SummaryTask[]): LastSyncSummary | null {
  const finished = tasks.filter((task): task is SummaryTask & { latestFinishedAt: string } =>
    Boolean(task.credentialGroupId) && isTerminalAutomationStatus(task.latestRunStatus) && Boolean(task.latestFinishedAt));
  if (finished.length === 0) return null;
  const newest = Math.max(...finished.map((task) => Date.parse(task.latestFinishedAt)));
  const latest = finished.filter((task) => newest - Date.parse(task.latestFinishedAt) <= SAME_SYNC_MS);
  const completed = latest.filter((task) => task.latestRunStatus === "completed").length;
  return {
    completed,
    unfinished: latest.length - completed,
    finishedAt: latest.find((task) => Date.parse(task.latestFinishedAt) === newest)!.latestFinishedAt,
  };
}
