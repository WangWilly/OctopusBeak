import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runCtbcProviderWorkflow,
  type CtbcProviderWorkflowOutput,
} from "../../workflows/ctbc-statements.ts";

/** Typed App-owned definition for CTBC statement collection. */
export const ctbcStatementsWorkflow: WorkflowDefinition<unknown, CtbcProviderWorkflowOutput> = {
  id: "ctbc-statements",
  requiresFinancialCommit: true,
  run: runCtbcProviderWorkflow,
};
