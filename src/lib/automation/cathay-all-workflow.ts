import type { WorkflowDefinition } from "./workflow-executor.ts";
import type { CathayGmailOtpPort } from "../../workflows/cathay-statements.ts";
import {
  runCathayAllProviderWorkflow,
  type CathayAllProviderWorkflowInput,
  type CathayAllProviderWorkflowOutput,
} from "../../workflows/cathay-all-statements.ts";

/** Bind the existing App-owned Gmail OTP service before registry activation.
 * No direct Gmail service import is made in this provider definition. */
export function createCathayAllStatementsWorkflow(
  otp: CathayGmailOtpPort,
): WorkflowDefinition<
  CathayAllProviderWorkflowInput,
  CathayAllProviderWorkflowOutput
> {
  return {
    id: "cathay-all-statements",
    requiresFinancialCommit: true,
    run: (context, input) =>
      runCathayAllProviderWorkflow(context, input, { otp }),
  };
}
