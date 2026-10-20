import type { AutomationTaskStatus } from "./types.ts";

export type ActiveAutomationRuntimeStatus = Extract<
  AutomationTaskStatus,
  "queued" | "preparing" | "running" | "waiting_for_human" | "cancelling"
>;

export function isActiveAutomationRuntimeStatus(
  status: string,
): status is ActiveAutomationRuntimeStatus {
  return status === "queued"
    || status === "preparing"
    || status === "running"
    || status === "waiting_for_human"
    || status === "cancelling";
}
