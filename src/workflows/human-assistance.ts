import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../lib/automation/human-assistance.ts";
import { resolveVerificationStage, type VerificationStage } from "../lib/automation/verification-stage.ts";
import { withAbort } from "./abort.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";

export type HumanAssistanceRequest = (
  contract: HumanAssistanceContractInput,
  signal: AbortSignal,
) => Promise<HumanAssistanceCompletionStatus>;

/**
 * Show a sign-in CAPTCHA stage to the person and wait for their answer.
 * Cancellation ends the wait at once; any status but entered or verified
 * fails the sign-in.
 */
export async function requestCaptchaAssistance(
  sourceName: string,
  stage: VerificationStage,
  request: HumanAssistanceRequest,
  signal: AbortSignal,
): Promise<Extract<HumanAssistanceCompletionStatus, "entered" | "verified">> {
  signal.throwIfAborted();
  const contract = await withAbort(resolveVerificationStage(stage), signal);
  const status = await withAbort(request(contract, signal), signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified")
    throw new Error(`${sourceName} human assistance ended with status ${status}.`);
  return status;
}

/** A sign-in helper's assistance step for the run; a failed one is its Run event signal (ADR 0059). */
export function humanAssistanceEvent(context: Pick<WorkflowContext, "event" | "signalEvent">) {
  return (code: "human-assistance-requested" | "human-assistance-completed" | "human-assistance-failed") =>
    code === "human-assistance-failed"
      ? context.signalEvent(code)
      : context.event("authentication", "advanced", code);
}
