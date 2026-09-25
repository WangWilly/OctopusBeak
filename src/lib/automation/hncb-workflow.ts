import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runHncbProviderWorkflow,
  type HncbWorkflowInput,
  type HncbWorkflowOutput,
} from "../../workflows/hncb-statements.ts";

/** App-owned HNCB domestic-deposit workflow definition. */
export const hncbDomesticDepositWorkflow: WorkflowDefinition<
  HncbWorkflowInput,
  HncbWorkflowOutput
> = {
  id: "hncb-statements",
  requiresFinancialCommit: true,
  run: runHncbProviderWorkflow,
};
