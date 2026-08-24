import { appendFileSync, writeSync } from "node:fs";
import {
  humanAssistanceContractFrame,
  HUMAN_ASSISTANCE_HOST_FD_ENV,
  HUMAN_ASSISTANCE_HOST_PATH_ENV,
  type HumanAssistanceCompletionInput,
  type HumanAssistanceContractInput,
  type HumanVerificationTarget,
  type VerificationContextRegion,
  type VerificationChallengeImageRegion,
  type VerificationChallengeKind,
  type HumanAssistanceFocus,
} from "../lib/automation/human-assistance.ts";
import type { Locator } from "playwright";

export type WorkflowHumanAssistanceTarget = Omit<HumanVerificationTarget, "rect"> & {
  locator: Pick<Locator, "boundingBox">;
};

export type WorkflowHumanAssistanceContextRegion = Omit<VerificationContextRegion, "rect"> & {
  locator?: Pick<Locator, "boundingBox">;
};

export type WorkflowChallengeImageRegion = Omit<VerificationChallengeImageRegion, "rect"> & {
  locator: Pick<Locator, "boundingBox">;
};

export type WorkflowHumanAssistanceStage = {
  stageId: string;
  title: string;
  targets: readonly WorkflowHumanAssistanceTarget[];
  contextRegions: readonly WorkflowHumanAssistanceContextRegion[];
  completion: HumanAssistanceCompletionInput;
  focus: HumanAssistanceFocus;
  challengeKind?: VerificationChallengeKind;
  challengeImageRegion?: WorkflowChallengeImageRegion;
};

export type HumanAssistanceContractPublisher = (contract: HumanAssistanceContractInput) => void;

function publishHumanAssistanceContractToHost(contract: HumanAssistanceContractInput) {
  const path = process.env[HUMAN_ASSISTANCE_HOST_PATH_ENV]?.trim();
  if (path) {
    appendFileSync(path, humanAssistanceContractFrame(contract), "utf8");
    return;
  }

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

  const contextRegions: VerificationContextRegion[] = [];
  for (const region of stage.contextRegions) {
    const rect = region.locator
      ? await region.locator.boundingBox().catch(() => null)
      : null;
    if (region.locator && (!rect || rect.width <= 0 || rect.height <= 0)) {
      throw new Error(`Human assistance context cannot be resolved: ${region.semanticId}`);
    }
    const { locator: _locator, ...descriptor } = region;
    contextRegions.push({ ...descriptor, ...(rect ? { rect } : {}) });
  }

  let challengeImageRegion: VerificationChallengeImageRegion | undefined;
  if (stage.challengeImageRegion) {
    const rect = await stage.challengeImageRegion.locator.boundingBox().catch(() => null);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Verification challenge image region cannot be resolved: ${stage.challengeImageRegion.semanticId}`);
    }
    const { locator: _locator, ...descriptor } = stage.challengeImageRegion;
    challengeImageRegion = { ...descriptor, rect };
  }

  const contract: HumanAssistanceContractInput = {
    stageId: stage.stageId,
    title: stage.title,
    targets,
    contextRegions,
    completion: stage.completion,
    focus: stage.focus,
    ...(stage.challengeKind === undefined ? {} : { challengeKind: stage.challengeKind }),
    ...(challengeImageRegion === undefined ? {} : { challengeImageRegion }),
  };
  return publishHumanAssistanceContract(contract, publish);
}
