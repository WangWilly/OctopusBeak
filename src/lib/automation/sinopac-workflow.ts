import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runSinopacProviderWorkflow,
  type SinopacWorkflowOutput,
} from "../../workflows/sinopac-statements.ts";

/** Typed App-owned definition; the Libretto handler remains for the migration period. */
export const sinopacStatementsWorkflow: WorkflowDefinition<unknown, SinopacWorkflowOutput> = {
  id: "sinopac-statements",
  requiresFinancialCommit: true,
  run: runSinopacProviderWorkflow,
};
