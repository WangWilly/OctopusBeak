import {
  humanAssistanceContractSignal,
  type HumanAssistanceCompletionInput,
  type HumanAssistanceContractInput,
  type HumanVerificationTarget,
  type VerificationContextRegion,
  type HumanAssistanceFocus,
} from "../lib/automation/human-assistance.ts";
import type { Locator } from "playwright";

export type WorkflowHumanAssistanceTarget = Omit<HumanVerificationTarget, "rect"> & {
  locator: Pick<Locator, "boundingBox">;
};

export type WorkflowHumanAssistanceStage = {
  stageId: string;
  title: string;
  targets: readonly WorkflowHumanAssistanceTarget[];
  contextRegions: readonly VerificationContextRegion[];
  completion: HumanAssistanceCompletionInput;
  focus: HumanAssistanceFocus;
};

export async function emitHumanAssistanceStage(
  stage: WorkflowHumanAssistanceStage,
): Promise<HumanAssistanceContractInput> {
  const targets: HumanVerificationTarget[] = [];
  for (const target of stage.targets) {
    const rect = await target.locator.boundingBox().catch(() => null);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Human assistance target cannot be resolved: ${target.semanticId}`);
    }
    const { locator: _locator, ...descriptor } = target;
    targets.push({ ...descriptor, rect });
  }

  const contract: HumanAssistanceContractInput = {
    stageId: stage.stageId,
    title: stage.title,
    targets,
    contextRegions: stage.contextRegions,
    completion: stage.completion,
    focus: stage.focus,
  };
  console.log(humanAssistanceContractSignal(contract));
  return contract;
}
