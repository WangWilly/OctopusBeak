import { isTerminalAutomationStatus } from "./task-row.ts";
import type { AutomationTaskRow } from "./types.ts";

/** What the Automation header says between runs: how the last runs ended, and when. */
export type LastSyncSummary = Readonly<{
  completed: number;
  /** Runs that ended any other way: partial, failed, cancelled, interrupted. */
  unfinished: number;
  /** The newest finish among those runs. */
  finishedAt: string;
}>;

/** Null until some task has finished a run. */
export function lastSyncSummary(tasks: readonly Pick<AutomationTaskRow, "status" | "latestFinishedAt">[]): LastSyncSummary | null {
  let completed = 0;
  let unfinished = 0;
  let finishedAt = "";
  for (const task of tasks) {
    if (!isTerminalAutomationStatus(task.status) || !task.latestFinishedAt) continue;
    if (task.status === "completed") completed += 1;
    else unfinished += 1;
    if (task.latestFinishedAt > finishedAt) finishedAt = task.latestFinishedAt;
  }
  return finishedAt ? { completed, unfinished, finishedAt } : null;
}
