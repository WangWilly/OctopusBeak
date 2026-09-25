import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runCtbcProviderWorkflow,
  type CtbcProviderWorkflowOutput,
} from "../../workflows/ctbc-statements.ts";

/** Typed App-owned CTBC definition; the Libretto command remains during migration. */
export const ctbcStatementsWorkflow: WorkflowDefinition<unknown, CtbcProviderWorkflowOutput> = {
  id: "ctbc-statements",
  requiresFinancialCommit: true,
  run: runCtbcProviderWorkflow,
};
