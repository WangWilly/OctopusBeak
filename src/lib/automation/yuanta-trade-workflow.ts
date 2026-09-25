import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runYuantaTradeProviderWorkflow,
  type YuantaTradeProviderWorkflowOutput,
} from "../../workflows/yuanta-trade-statements.ts";

/** App-owned Yuanta Trade provider definition; the Libretto CLI path remains during migration. */
export const yuantaTradeStatementsWorkflow: WorkflowDefinition<unknown, YuantaTradeProviderWorkflowOutput> = {
  id: "yuanta-trade-statements",
  requiresFinancialCommit: true,
  run: runYuantaTradeProviderWorkflow,
};
