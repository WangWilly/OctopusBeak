import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrAttemptStrategy,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
  HumanAssistanceContract,
  SolveAcceptancePolicy,
} from "../human-assistance.ts";
import { resolveHumanAssistanceSolverMetadata } from "../human-assistance.ts";
import {
  DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD,
  challengeConfidenceThreshold,
  isSolverChallengeKind,
  verificationActorForSource,
  type VerificationActor,
} from "../verification-config.ts";
import {
  solveVerificationChallenge,
  verificationPlanForContract,
  type SolveOutcome,
  type VerificationSelectionPoint,
  type VerificationSolver,
} from "./verification-solver.ts";
import { localVerificationSolver } from "./local-verification-solver.ts";
import {
  captureChallengeImageForContract,
  clickVerificationTarget,
  injectVerificationSelections,
} from "./automation-viewer.ts";
import {
  captureProviderVerificationAudio,
  captureProviderVerificationImage,
  injectProviderVerificationAnswer,
  isProviderVerificationImageCurrent,
  providerVerificationHandlesChallengeImage,
} from "./provider-verification.ts";
import type { ProviderVerificationHost } from "./provider-verification.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import { readAutomationSettings } from "./settings.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import type { AutomationPersistenceProvider } from "./store.ts";

export type VerificationRoutingDependencies = {
  solver: VerificationSolver;
  captureChallengeImage: (
    taskRunId: string,
    contract: HumanAssistanceContract,
  ) => Promise<Buffer | null>;
  captureChallengeAudio?: (
    taskRunId: string,
    contract: HumanAssistanceContract,
  ) => Promise<Buffer | null>;
  validateChallengeImage?: (
    taskRunId: string,
    contract: HumanAssistanceContract,
  ) => Promise<boolean>;
  injectAnswer: (
    taskRunId: string,
    contract: HumanAssistanceContract,
    answer: string,
  ) => Promise<void>;
  probePostSubmit?: ProviderVerificationHost["probePostSubmit"];
  injectSelections: (
    taskRunId: string,
    contract: HumanAssistanceContract,
    selections: readonly VerificationSelectionPoint[],
  ) => Promise<void>;
  clickTarget: (
    taskRunId: string,
    contract: HumanAssistanceContract,
    targetId: string,
  ) => Promise<void>;
  resumeAppWorkflow: () => void | Promise<void>;
  finalizeFailed: (message: string) => void | Promise<void>;
  /** Called once after a non-empty challenge image has been captured. */
  onChallengeCaptured?: () => void | Promise<void>;
};

export type VerificationChallengeImageProvider = Pick<
  ProviderVerificationHost,
  "handlesChallengeImage" | "captureChallengeImage" | "isChallengeImageCurrent"
>;

export type VerificationChallengeImageSelection = {
  captureChallengeImage: VerificationRoutingDependencies["captureChallengeImage"];
  validateChallengeImage?: VerificationRoutingDependencies["validateChallengeImage"];
  /** A registered source owner treats a null capture as a hard failure. */
  providerOwned: boolean;
};

class ProviderChallengeImageCaptureError extends Error {
  constructor() {
    super("Verification challenge image capture failed.");
    this.name = "ProviderChallengeImageCaptureError";
  }
}

/**
 * Select the image seam once for a contract. A registered provider owner is
 * authoritative: a failed provider capture is returned as-is and never
 * falls through to the generic contract rectangle screenshot. Contracts
 * without a source owner retain the generic viewer behavior.
 */
export function selectVerificationChallengeImage(
  contract: HumanAssistanceContract,
  options: {
    provider: VerificationChallengeImageProvider;
    genericCaptureChallengeImage: VerificationRoutingDependencies["captureChallengeImage"];
  },
): VerificationChallengeImageSelection {
  if (options.provider.handlesChallengeImage(contract)) {
    return {
      captureChallengeImage: (viewerKey, currentContract) =>
        options.provider.captureChallengeImage(viewerKey, currentContract),
      validateChallengeImage: (viewerKey, currentContract) =>
        options.provider.isChallengeImageCurrent(viewerKey, currentContract),
      providerOwned: true,
    };
  }
  return {
    captureChallengeImage: options.genericCaptureChallengeImage,
    providerOwned: false,
  };
}

export type VerificationRoutingOutcome =
  | { kind: "human" }
  | { kind: "resumed" }
  | { kind: "failed" }
  | {
    kind: "retryable";
    reason: "solver-exhausted" | "provider-rejected";
  };

const defaultLocalSolver = localVerificationSolver();

export async function routeVerificationActor(input: {
  actor: VerificationActor;
  contract: HumanAssistanceContract | null;
  taskRunId: string;
  confidenceThreshold: number | undefined;
  prompt?: string;
  charset?: ChallengeCharacterSet;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
  ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode;
  ocrAttemptPlan?: readonly CaptchaOcrAttemptStrategy[];
  solveAcceptancePolicy?: SolveAcceptancePolicy;
  expectedAnswerLength?: number;
  dependencies: VerificationRoutingDependencies;
}): Promise<VerificationRoutingOutcome> {
  if (input.actor !== "solver") return { kind: "human" };
  const contract = input.contract;
  const plan = verificationPlanForContract(contract);
  const deps = input.dependencies;
  if (plan.kind === "proceed") {
    await deps.resumeAppWorkflow();
    return { kind: "resumed" };
  }
  if (plan.kind === "click") {
    await deps.clickTarget(input.taskRunId, contract!, plan.targetId);
    await deps.resumeAppWorkflow();
    return { kind: "resumed" };
  }
  if (plan.kind === "unsolvable") {
    await deps.finalizeFailed("Verification challenge cannot be solved.");
    return { kind: "failed" };
  }
  let outcome: SolveOutcome;
  let challengeCaptured = false;
  try {
    const solverMetadata = resolveHumanAssistanceSolverMetadata(contract, {
      prompt: input.prompt,
      charset: input.charset,
      imagePreprocessing: input.imagePreprocessing,
      ocrPageSegmentationMode: input.ocrPageSegmentationMode,
      ocrAttemptPlan: input.ocrAttemptPlan,
      solveAcceptancePolicy: input.solveAcceptancePolicy,
      expectedAnswerLength: input.expectedAnswerLength,
    });
    outcome = await solveVerificationChallenge({
      challengeKind: plan.challengeKind,
      confidenceThreshold:
        contract?.solverConfidenceThreshold
        ?? input.confidenceThreshold
        ?? DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD,
      solver: deps.solver,
      captureChallengeImage: async () => {
        const image = await deps.captureChallengeImage(input.taskRunId, contract!);
        if (image !== null && !challengeCaptured) {
          challengeCaptured = true;
          await deps.onChallengeCaptured?.();
        }
        return image;
      },
      captureChallengeAudio: deps.captureChallengeAudio
        ? () => deps.captureChallengeAudio!(input.taskRunId, contract!)
        : undefined,
      injectAnswer: (answer) =>
        deps.injectAnswer(input.taskRunId, contract!, answer),
      injectSelections: (selections) =>
        deps.injectSelections(input.taskRunId, contract!, selections),
      validateChallengeImage: deps.validateChallengeImage
        ? () => deps.validateChallengeImage!(input.taskRunId, contract!)
        : undefined,
      ...solverMetadata,
    });
  } catch (error) {
    await deps.finalizeFailed(
      error instanceof ProviderChallengeImageCaptureError
        ? error.message
        : "Verification solver failed to solve the challenge.",
    );
    return { kind: "failed" };
  }
  if (outcome.status === "solved" || outcome.status === "absent") {
    const postSubmitOutcome = deps.probePostSubmit
      ? await deps.probePostSubmit(
        input.taskRunId,
        contract!,
        () => Promise.resolve(deps.resumeAppWorkflow()),
      )
      : (await deps.resumeAppWorkflow(), "none" as const);
    if (postSubmitOutcome === "provider-rejected") {
      return { kind: "retryable", reason: "provider-rejected" };
    }
    if (postSubmitOutcome === "unrecognized-dialog") {
      await deps.finalizeFailed("Provider login dialog was not recognized.");
      return { kind: "failed" };
    }
    return { kind: "resumed" };
  }
  return { kind: "retryable", reason: "solver-exhausted" };
}

export async function routeWaitingRunVerification(input: {
  taskId: string;
  taskRunId: string;
  provider: AutomationPersistenceProvider;
  resumeAppWorkflow: () => void | Promise<void>;
  solver?: VerificationSolver;
  captureChallengeImage?: VerificationRoutingDependencies["captureChallengeImage"];
  captureChallengeAudio?: VerificationRoutingDependencies["captureChallengeAudio"];
  providerCaptureChallengeAudio?: ProviderVerificationHost["captureChallengeAudio"];
  validateChallengeImage?: VerificationRoutingDependencies["validateChallengeImage"];
  injectAnswer?: VerificationRoutingDependencies["injectAnswer"];
  providerProbePostSubmit: ProviderVerificationHost["probePostSubmit"];
  providerInjectAnswer?: ProviderVerificationHost["injectAnswer"];
  injectSelections?: VerificationRoutingDependencies["injectSelections"];
  clickTarget?: VerificationRoutingDependencies["clickTarget"];
  finalizeFailed: VerificationRoutingDependencies["finalizeFailed"];
  onChallengeCaptured?: VerificationRoutingDependencies["onChallengeCaptured"];
  providerVerification?: VerificationChallengeImageProvider;
  genericCaptureChallengeImage?: VerificationRoutingDependencies["captureChallengeImage"];
  settings?: AutomationSettingsFile;
  /** Keep an App-owned assistance stage open for manual entry when OCR is inconclusive. */
  humanFallbackOnSolverExhausted?: boolean;
}): Promise<VerificationRoutingOutcome> {
  const task = taskById(input.taskId);
  if (!task?.workflowId) {
    await input.finalizeFailed("Verification routing requires an App browser workflow.");
    return { kind: "failed" };
  }
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  const settings = input.settings ?? readAutomationSettings();
  const actor = verificationActorForSource(group?.verificationActorKey, settings);
  const run = await input.provider.automation.taskRunById(input.taskRunId);
  if (
    !run
    || run.taskId !== input.taskId
    || run.status !== "waiting_for_human"
    || !run.humanAssistanceContract
  ) {
    await input.finalizeFailed("App workflow verification stage is unavailable.");
    return { kind: "failed" };
  }
  if (actor !== "solver") return { kind: "human" };

  const contract = run.humanAssistanceContract;
  const taskRunId = input.taskRunId;
  const kind = contract?.challengeKind;
  const confidenceThreshold = isSolverChallengeKind(kind)
    ? contract?.solverConfidenceThreshold
      ?? challengeConfidenceThreshold(settings, kind)
    : undefined;
  const providerVerification: VerificationChallengeImageProvider = input.providerVerification ?? {
    handlesChallengeImage: providerVerificationHandlesChallengeImage,
    captureChallengeImage: captureProviderVerificationImage,
    isChallengeImageCurrent: isProviderVerificationImageCurrent,
  };
  const imageSelection = contract
    ? selectVerificationChallengeImage(contract, {
        provider: providerVerification,
        genericCaptureChallengeImage: input.genericCaptureChallengeImage
          ?? captureChallengeImageForContract,
      })
    : {
        captureChallengeImage: input.genericCaptureChallengeImage
          ?? captureChallengeImageForContract,
        validateChallengeImage: undefined,
        providerOwned: false,
      };
  const capture = input.captureChallengeImage ?? imageSelection.captureChallengeImage;
  const selectedCapture = imageSelection.providerOwned
    ? async (selectedTaskRunId: string, selectedContract: HumanAssistanceContract) => {
        const image = await capture(selectedTaskRunId, selectedContract);
        if (image === null) throw new ProviderChallengeImageCaptureError();
        return image;
      }
    : capture;
  const dependencies: VerificationRoutingDependencies = {
    solver: input.solver ?? defaultLocalSolver,
    captureChallengeImage: selectedCapture,
    captureChallengeAudio: input.captureChallengeAudio
      ?? input.providerCaptureChallengeAudio
      ?? captureProviderVerificationAudio,
    validateChallengeImage: input.validateChallengeImage
      ?? imageSelection.validateChallengeImage,
    injectAnswer: input.injectAnswer
      ?? input.providerInjectAnswer
      ?? injectProviderVerificationAnswer,
    probePostSubmit: input.providerProbePostSubmit,
    injectSelections: input.injectSelections ?? injectVerificationSelections,
    clickTarget: input.clickTarget ?? clickVerificationTarget,
    resumeAppWorkflow: input.resumeAppWorkflow,
    finalizeFailed: input.finalizeFailed,
    onChallengeCaptured: input.onChallengeCaptured,
  };
  const outcome = await routeVerificationActor({
    actor,
    contract,
    taskRunId,
    confidenceThreshold,
    dependencies,
  });
  if (
    input.humanFallbackOnSolverExhausted
    && outcome.kind === "retryable"
    && outcome.reason === "solver-exhausted"
  ) {
    return { kind: "human" };
  }
  return outcome;
}
