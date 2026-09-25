import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runEinvoiceProviderWorkflow,
  type EinvoiceWorkflowOutput,
} from "../../workflows/einvoice-personal-invoices.ts";

/** Typed App-owned definition for personal invoice collection. */
export const einvoicePersonalInvoicesWorkflow: WorkflowDefinition<unknown, EinvoiceWorkflowOutput> = {
  id: "einvoice-personal-invoices",
  requiresFinancialCommit: true,
  run: runEinvoiceProviderWorkflow,
};
