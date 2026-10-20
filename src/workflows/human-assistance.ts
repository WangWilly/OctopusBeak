import {
  type HumanAssistanceCompletionInput,
  type HumanAssistanceCompletionStatus,
  type HumanAssistanceContractInput,
  type HumanVerificationTarget,
  type VerificationContextRegion,
  type VerificationChallengeImageRegion,
  type VerificationChallengeAudioSource,
  type VerificationChallengeKind,
  type ChallengeCharacterSet,
  type CaptchaImagePreprocessingMode,
  type CaptchaOcrPageSegmentationMode,
  type CaptchaOcrAttemptStrategy,
  type HumanAssistanceFocus,
  type SolveAcceptancePolicy,
} from "../lib/automation/human-assistance.ts";
import type { Locator } from "playwright";
import { withAbort } from "./abort.ts";

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
  const contract: HumanAssistanceContractInput = {
    ...contractMetadata,
    targets,
    contextRegions,
    ...(challengeImageRegion === undefined ? {} : { challengeImageRegion }),
  };
  return contract;
}

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
  stage: WorkflowHumanAssistanceStage,
  request: HumanAssistanceRequest,
  signal: AbortSignal,
): Promise<Extract<HumanAssistanceCompletionStatus, "entered" | "verified">> {
  signal.throwIfAborted();
  const contract = await withAbort(emitHumanAssistanceStage(stage), signal);
  const status = await withAbort(request(contract, signal), signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified")
    throw new Error(`${sourceName} human assistance ended with status ${status}.`);
  return status;
}
