import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runLineBankProviderWorkflow,
  type LineBankProviderWorkflowInput,
  type LineBankProviderWorkflowOutput,
} from "../../workflows/linebank-statements.ts";

/** App-owned LINE Bank statements workflow; the Libretto entry remains during migration. */
export const linebankStatementsWorkflow: WorkflowDefinition<
  LineBankProviderWorkflowInput,
  LineBankProviderWorkflowOutput
> = {
  id: "linebank-statements",
  requiresFinancialCommit: true,
  run: runLineBankProviderWorkflow,
};
