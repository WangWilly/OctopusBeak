import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runSinopacProviderWorkflow,
  type SinopacWorkflowOutput,
} from "../../workflows/sinopac-statements.ts";

/** Typed App-owned workflow definition for SinoPac statement collection. */
export const sinopacStatementsWorkflow: WorkflowDefinition<unknown, SinopacWorkflowOutput> = {
  id: "sinopac-statements",
  requiresFinancialCommit: true,
  run: runSinopacProviderWorkflow,
};
