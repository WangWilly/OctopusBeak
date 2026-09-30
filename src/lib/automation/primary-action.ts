import type { AutomationTaskStatus } from "./types.ts";

/** Derive the primary task action from the authoritative lifecycle status. */
export function primaryActionForAutomationTask(
  status: AutomationTaskStatus,
  isActive: boolean,
) {
  if (isActive) return "Cancel" as const;
  if (status === "needs_setup") return "Configure" as const;
  if (status === "locked") return "Locked" as const;
  if (status === "failed") return "Run again" as const;
  if (status === "waiting_for_human") return "Cancel" as const;
  return "Run" as const;
}
