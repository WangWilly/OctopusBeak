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
  probeProviderVerificationPostSubmit,
  providerVerificationHandlesChallengeImage,
} from "./provider-verification.ts";
import { appWorkflowPageForSession } from "./app-browser-host.ts";
import type { ProviderVerificationHost } from "./provider-verification.ts";
import { taskById } from "./tasks.ts";
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
  | { kind: "resumed" }
  | { kind: "failed" }
  | {
    kind: "retryable";
    reason: "solver-exhausted" | "provider-rejected";
  };

const defaultLocalSolver = localVerificationSolver();

const TEXT_CAPTCHA_APP_TASK_IDS: ReadonlySet<string> = new Set([
  "fubon-all-statements",
  "yuanta-all-statements",
  "hncb-statements",
  "post-statements",
  "einvoice-personal-invoices",
  "sinopac-statements",
]);

/** App browser workflows whose verification stages reach the solver route. */
export function appWorkflowRoutesVerification(taskId: string) {
  return TEXT_CAPTCHA_APP_TASK_IDS.has(taskId) || taskId === "yuanta-trade-statements";
}

/**
 * These providers classify submission results inside the workflow. Join the
 * completed execution instead of racing a second owner of browser dialogs.
 */
export const WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS: ReadonlySet<string> = new Set([
  "sinopac-statements", "post-statements", "einvoice-personal-invoices", "yuanta-all-statements",
]);

export function appProviderPostSubmitProbe(): ProviderVerificationHost["probePostSubmit"] {
  return async (viewerKey, contract, resume) =>
    await probeProviderVerificationPostSubmit(
      viewerKey,
      contract,
      resume,
      async () => {
        const page = appWorkflowPageForSession(viewerKey);
        if (!page) throw new Error("App verification browser session is unavailable for cleanup.");
        await page.context().close();
      },
    );
}

export async function routeVerificationActor(input: {
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
      ? async () => {
          const audio = await deps.captureChallengeAudio!(input.taskRunId, contract!);
          if (audio !== null && !challengeCaptured) {
            challengeCaptured = true;
            await deps.onChallengeCaptured?.();
          }
          return audio;
        }
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

/** Browser seams for one contract; omitted seams use the App's provider and viewer defaults. */
export type VerificationRoutingSeams = {
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
};

export function verificationConfidenceThreshold(
  contract: HumanAssistanceContract,
  settings: AutomationSettingsFile,
): number | undefined {
  const kind = contract.challengeKind;
  return isSolverChallengeKind(kind)
    ? contract.solverConfidenceThreshold
      ?? challengeConfidenceThreshold(settings, kind)
    : undefined;
}

export function verificationRoutingDependencies(
  contract: HumanAssistanceContract,
  input: VerificationRoutingSeams,
): VerificationRoutingDependencies {
  const providerVerification: VerificationChallengeImageProvider = input.providerVerification ?? {
    handlesChallengeImage: providerVerificationHandlesChallengeImage,
    captureChallengeImage: captureProviderVerificationImage,
    isChallengeImageCurrent: isProviderVerificationImageCurrent,
  };
  const imageSelection = selectVerificationChallengeImage(contract, {
    provider: providerVerification,
    genericCaptureChallengeImage: input.genericCaptureChallengeImage
      ?? captureChallengeImageForContract,
  });
  const capture = input.captureChallengeImage ?? imageSelection.captureChallengeImage;
  const selectedCapture = imageSelection.providerOwned
    ? async (selectedTaskRunId: string, selectedContract: HumanAssistanceContract) => {
        const image = await capture(selectedTaskRunId, selectedContract);
        if (image === null) throw new ProviderChallengeImageCaptureError();
        return image;
      }
    : capture;
  return {
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
}

export async function routeWaitingRunVerification(input: VerificationRoutingSeams & {
  taskId: string;
  taskRunId: string;
  provider: AutomationPersistenceProvider;
  settings?: AutomationSettingsFile;
}): Promise<VerificationRoutingOutcome> {
  const task = taskById(input.taskId);
  if (!task?.workflowId) {
    await input.finalizeFailed("Verification routing requires an App browser workflow.");
    return { kind: "failed" };
  }
  const settings = input.settings ?? readAutomationSettings();
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
  const contract = run.humanAssistanceContract;
  return routeVerificationActor({
    contract,
    taskRunId: input.taskRunId,
    confidenceThreshold: verificationConfidenceThreshold(contract, settings),
    dependencies: verificationRoutingDependencies(contract, input),
  });
}
