import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runPostProviderWorkflow,
  type PostWorkflowInput,
  type PostWorkflowOutput,
} from "../../workflows/post-statements.ts";

/** App-owned Chunghwa Post domestic-deposit workflow definition. */
export const postDomesticDepositWorkflow: WorkflowDefinition<
  PostWorkflowInput,
  PostWorkflowOutput
> = {
  id: "post-statements",
  requiresFinancialCommit: true,
  run: runPostProviderWorkflow,
};
