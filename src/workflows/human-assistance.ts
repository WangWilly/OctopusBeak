import { writeSync } from "node:fs";
import {
  humanAssistanceContractFrame,
  HUMAN_ASSISTANCE_HOST_FD_ENV,
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

export type HumanAssistanceContractPublisher = (contract: HumanAssistanceContractInput) => void;

function publishHumanAssistanceContractToHost(contract: HumanAssistanceContractInput) {
  const fd = Number(process.env[HUMAN_ASSISTANCE_HOST_FD_ENV]);
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error("Human assistance host API is unavailable for this workflow run.");
  }
  writeSync(fd, humanAssistanceContractFrame(contract), undefined, "utf8");
}

export function publishHumanAssistanceContract(
  contract: HumanAssistanceContractInput,
  publish: HumanAssistanceContractPublisher = publishHumanAssistanceContractToHost,
) {
  publish(contract);
  return contract;
}

export async function emitHumanAssistanceStage(
  stage: WorkflowHumanAssistanceStage,
  publish: HumanAssistanceContractPublisher = publishHumanAssistanceContractToHost,
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
  return publishHumanAssistanceContract(contract, publish);
}
