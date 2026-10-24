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
import type { WorkflowContext, WorkflowHumanAssistancePort } from "./workflow-executor.ts";
import { withAbort } from "../../workflows/abort.ts";

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

/** How a workflow hands a Verification stage to the solver. */
export interface WorkflowVerificationPort {
  /**
   * Resolves once the stage is entered or verified. Rejects with the run's
   * abort reason when the run is cancelled, and otherwise with
   * VerificationStageIncompleteError.
   */
  complete(stage: VerificationStage): Promise<void>;
}

/** The host keeps why the stage failed; the run records only the failed signal. */
export class VerificationStageIncompleteError extends Error {
  constructor() {
    super("The Verification stage did not complete.");
    this.name = "VerificationStageIncompleteError";
  }
}

export type ReportedVerificationOptions = Readonly<{
  humanAssistance: WorkflowHumanAssistancePort;
  signal: AbortSignal;
  event: WorkflowContext["event"];
  signalEvent: WorkflowContext["signalEvent"];
}>;

/**
 * The one module that reports a Verification stage: requested and completed
 * as authentication progress, and any end but completion or cancellation as
 * the human-assistance-failed signal (ADR 0059).
 */
export function reportedVerificationPort(options: ReportedVerificationOptions): WorkflowVerificationPort {
  const { humanAssistance, signal, event, signalEvent } = options;
  const incomplete = async (): Promise<never> => {
    await signalEvent("human-assistance-failed");
    throw new VerificationStageIncompleteError();
  };
  return {
    async complete(stage) {
      signal.throwIfAborted();
      let contract: HumanAssistanceContractInput;
      try {
        contract = await withAbort(resolveVerificationStage(stage), signal);
      } catch {
        signal.throwIfAborted();
        return await incomplete();
      }
      await event("authentication", "advanced", "human-assistance-requested");
      let status: Awaited<ReturnType<WorkflowHumanAssistancePort["request"]>>;
      try {
        status = await withAbort(humanAssistance.request(contract, signal), signal);
      } catch {
        signal.throwIfAborted();
        return await incomplete();
      }
      signal.throwIfAborted();
      if (status !== "entered" && status !== "verified") return await incomplete();
      await event("authentication", "advanced", "human-assistance-completed");
    },
  };
}
