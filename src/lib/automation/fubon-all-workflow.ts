import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runFubonAllStatementsWorkflow,
  type FubonAllWorkflowInput,
  type FubonAllWorkflowOutput,
} from "../../workflows/fubon-all-statements.ts";

/** App-owned Fubon parent; legacy Libretto entry points remain during migration. */
export const fubonAllStatementsWorkflow: WorkflowDefinition<
  FubonAllWorkflowInput,
  FubonAllWorkflowOutput
> = {
  id: "fubon-all-statements",
  requiresFinancialCommit: true,
  run: runFubonAllStatementsWorkflow,
};
