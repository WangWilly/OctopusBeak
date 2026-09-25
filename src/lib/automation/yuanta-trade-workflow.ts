import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runYuantaTradeProviderWorkflow,
  type YuantaTradeProviderWorkflowOutput,
} from "../../workflows/yuanta-trade-statements.ts";

/** Typed App-owned definition for Yuanta Trade investment collection. */
export const yuantaTradeStatementsWorkflow: WorkflowDefinition<unknown, YuantaTradeProviderWorkflowOutput> = {
  id: "yuanta-trade-statements",
  requiresFinancialCommit: true,
  run: runYuantaTradeProviderWorkflow,
};
