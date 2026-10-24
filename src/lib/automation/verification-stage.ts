import type { Locator } from "playwright";
import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrAttemptStrategy,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
  HumanAssistanceCompletionInput,
  HumanAssistanceContractInput,
  HumanAssistanceFocus,
  HumanVerificationTarget,
  SolveAcceptancePolicy,
  VerificationChallengeAudioSource,
  VerificationChallengeImageRegion,
  VerificationChallengeKind,
  VerificationContextRegion,
} from "./human-assistance.ts";

type BoxLocator = Pick<Locator, "boundingBox">;

export type VerificationStageTarget = Omit<HumanVerificationTarget, "rect"> & {
  locator: BoxLocator;
};

export type VerificationStageContextRegion = Omit<VerificationContextRegion, "rect"> & {
  locator?: BoxLocator;
};

export type VerificationStageChallengeImageRegion = Omit<VerificationChallengeImageRegion, "rect"> & {
  locator: BoxLocator;
};

/** A Verification stage as a workflow declares it, with page locators in place of rects. */
export type VerificationStage = {
  stageId: string;
  title: string;
  targets: readonly VerificationStageTarget[];
  contextRegions: readonly VerificationStageContextRegion[];
  completion: HumanAssistanceCompletionInput;
  focus: HumanAssistanceFocus;
  challengeKind?: VerificationChallengeKind;
  challengeImageRegion?: VerificationStageChallengeImageRegion;
  challengeAudioSource?: VerificationChallengeAudioSource;
  charset?: ChallengeCharacterSet;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
  ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode;
  ocrAttemptPlan?: readonly CaptchaOcrAttemptStrategy[];
  solveAcceptancePolicy?: SolveAcceptancePolicy;
  solverConfidenceThreshold?: number;
  expectedAnswerLength?: number;
  prompt?: string;
};

export async function resolveVerificationStage(
  stage: VerificationStage,
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
    if (rect && rect.width > 0 && rect.height > 0) {
      const { locator: _locator, ...descriptor } = stage.challengeImageRegion;
      challengeImageRegion = { ...descriptor, rect };
    }
  }

  const {
    targets: _stageTargets,
    contextRegions: _stageContextRegions,
    challengeImageRegion: _stageChallengeImageRegion,
    ...contractMetadata
  } = stage;
  return {
    ...contractMetadata,
    targets,
    contextRegions,
    ...(challengeImageRegion === undefined ? {} : { challengeImageRegion }),
  };
}
