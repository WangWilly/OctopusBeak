import type { AutomationPageModel } from "../automation/types.ts";
import type { DashboardBlockValueMap } from "./dashboard-blocks.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import { selectAutomationBlockModel } from "../automation/runtime-sync.ts";
import type { AutomationActionToken } from "../automation/runtime-controller.ts";

/** Resolve an automation section from its own settled block payload. */
export function resolveAutomationBlock(
  fallback: AutomationPageModel,
  block?:
    | DashboardBlockValueMap["automation"]["summary"]
    | DashboardBlockValueMap["automation"]["list"]
    | DashboardBlockValueMap["automation"]["details"],
  runtime?: AutomationRuntimeSnapshot | null,
  pendingActions?: readonly AutomationActionToken[],
): AutomationPageModel {
  return selectAutomationBlockModel(fallback, block?.automation, runtime, pendingActions);
}
