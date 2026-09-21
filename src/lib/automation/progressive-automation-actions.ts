import type { DashboardBlockValueMap } from "../shared-shell/dashboard-blocks.ts";
import { resolveAutomationBlock } from "../shared-shell/progressive-dashboard-data.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";

/**
 * The list block and its action must share one task source.  Keeping this
 * selection at a pure seam makes the fallback (before a block settles) and
 * the settled block behavior observable without mounting the dashboard.
 */
export function automationStageTasks(
  fallback: AutomationPageModel,
  block?: DashboardBlockValueMap["automation"]["list"],
  runtime?: AutomationRuntimeSnapshot | null,
): AutomationTaskRow[] {
  return resolveAutomationBlock(fallback, block, runtime).tasks;
}

/** Pass exactly the displayed stage tasks to the sync-sheet action. */
export function dispatchAutomationStageSync(
  tasks: AutomationTaskRow[],
  openSyncSheet: (tasks: AutomationTaskRow[]) => void,
): void {
  openSyncSheet(tasks);
}
