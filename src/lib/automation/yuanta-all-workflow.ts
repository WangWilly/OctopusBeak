import type { WorkflowDefinition } from "./workflow-executor.ts";
import {
  runYuantaAllStatementsWorkflow,
  type YuantaAllWorkflowInput,
  type YuantaAllWorkflowOutput,
} from "../../workflows/yuanta-all-statements.ts";

/** App-owned Yuanta parent. Legacy Libretto exports remain during activation. */
export const yuantaAllStatementsWorkflow: WorkflowDefinition<
  YuantaAllWorkflowInput,
  YuantaAllWorkflowOutput
> = {
  id: "yuanta-all-statements",
  requiresFinancialCommit: true,
  run: runYuantaAllStatementsWorkflow,
};
