import {
  executePGliteWorkflowRun,
} from "../../ledger/pglite/workflow-run.ts";
import type { PGliteWorkflowClient } from "../../ledger/pglite/workflow-client.ts";
import type { WorkflowFinancialCommitPort } from "./workflow-executor.ts";

/** App/worker composition root supplies the authenticated canonical client. */
export function createWorkflowFinancialCommitPort(
  client: PGliteWorkflowClient,
): WorkflowFinancialCommitPort {
  return {
    execute(items, options) {
      return executePGliteWorkflowRun({
        client,
        items,
        ...(options?.provider ? { provider: options.provider } : {}),
        ...(options?.product ? { product: options.product } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
  };
}
