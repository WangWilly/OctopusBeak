import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runLineBankProviderWorkflow,
  type LineBankProviderWorkflowInput,
  type LineBankProviderWorkflowOutput,
} from "../../workflows/linebank-statements.ts";

/** Typed App-owned workflow definition for LINE Bank statement collection. */
export const linebankStatementsWorkflow: WorkflowDefinition<
  LineBankProviderWorkflowInput,
  LineBankProviderWorkflowOutput
> = {
  id: "linebank-statements",
  requiresFinancialCommit: true,
  run: runLineBankProviderWorkflow,
};
