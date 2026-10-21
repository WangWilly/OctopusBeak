import type { DashboardBlockKey } from "../src/lib/shared-shell/block-load-state.ts";
import {
  wrapDashboardBlock,
  type DashboardBlockPayload,
} from "../src/lib/shared-shell/dashboard-blocks.ts";

const AUTOMATION_SUMMARY_FIELDS = ["automation", "runtimeSessionId", "runtimeRevision"] as const;
const AUTOMATION_BLOCK_FIELDS = ["automation", "credentialGroups", "runtimeSessionId", "runtimeRevision"] as const;

/** Narrow the Automation page model to the fields one dashboard block renders. */
export function projectAutomationBlock(model: object, block: DashboardBlockKey): DashboardBlockPayload {
  const record = model as Record<string, unknown>;
  const fields = block === "summary" ? AUTOMATION_SUMMARY_FIELDS : AUTOMATION_BLOCK_FIELDS;
  const data = Object.fromEntries(fields
    .filter((field) => record[field] !== undefined)
    .map((field) => [field, record[field]]));
  return wrapDashboardBlock("automation", block as never, data as never) as unknown as DashboardBlockPayload;
}
