import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runEsunCreditCardProviderWorkflow,
  type EsunProviderWorkflowOutput,
} from "../../workflows/esun-credit-card-statements.ts";

/** Typed App-owned definition; the Libretto default export stays during migration. */
export const esunCreditCardStatementsWorkflow: WorkflowDefinition<unknown, EsunProviderWorkflowOutput> = {
  id: "esun-credit-card-statements",
  requiresFinancialCommit: true,
  run: runEsunCreditCardProviderWorkflow,
};
