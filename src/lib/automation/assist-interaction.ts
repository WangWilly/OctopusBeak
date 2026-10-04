import type { HumanAssistanceCompletion } from "./human-assistance.ts";

export function settleAssistTextSubmission<T>(input: T, succeeded: boolean) {
  return {
    floatingInput: succeeded ? null : input,
    assistInteracted: succeeded,
  };
}

export function canResumeAssist(
  assistInteracted: boolean,
  floatingInputOpen: boolean,
  completion: HumanAssistanceCompletion | null | undefined,
) {
  if (!assistInteracted || floatingInputOpen || !completion) return false;
  if (completion.mode === "inline") return completion.status === "entered";
  return completion.status === "verified";
}

export function shouldGuideAssistViewer(
  assistInteracted: boolean,
  floatingInputOpen: boolean,
  completion: HumanAssistanceCompletion | null | undefined,
) {
  if (floatingInputOpen || !completion) return false;
  if (completion.mode === "independent") return completion.status !== "verified";
  return !assistInteracted && completion.status !== "entered";
}

export function settleAssistDrag(succeeded: boolean) {
  return succeeded;
}
