import type { LedgerDatabase } from "../../../ledger/db/client.ts";
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
  injectVerificationAnswer,
  injectVerificationSelections,
} from "./automation-viewer.ts";
import {
  captureProviderVerificationImage,
  isProviderVerificationImageCurrent,
  providerVerificationHandlesChallengeImage,
} from "./provider-verification.ts";
import type { ProviderVerificationHost } from "./provider-verification.ts";
import { finalizeFailedWaitingRun } from "./task-run-finalization.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import { readAutomationSettings } from "./settings.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import { sessionFromRun } from "./automation-session-disposition.ts";
import { taskRunById } from "./store.ts";

export type VerificationRoutingDependencies = {
  solver: VerificationSolver;
  captureChallengeImage: (
    session: string,
    contract: HumanAssistanceContract,
  ) => Promise<Buffer | null>;
  validateChallengeImage?: (
    session: string,
    contract: HumanAssistanceContract,
  ) => Promise<boolean>;
  injectAnswer: (
    session: string,
    contract: HumanAssistanceContract,
    answer: string,
  ) => Promise<void>;
  injectSelections: (
    session: string,
    contract: HumanAssistanceContract,
    selections: readonly VerificationSelectionPoint[],
  ) => Promise<void>;
  clickTarget: (
    session: string,
    contract: HumanAssistanceContract,
    targetId: string,
  ) => Promise<void>;
  resume: (session: string) => void | Promise<void>;
  finalizeFailed: (message: string) => void | Promise<void>;
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
      captureChallengeImage: (session, currentContract) =>
        options.provider.captureChallengeImage(session, currentContract),
      validateChallengeImage: (session, currentContract) =>
        options.provider.isChallengeImageCurrent(session, currentContract),
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
  | { kind: "failed" };

const defaultLocalSolver = localVerificationSolver();

export async function routeVerificationActor(input: {
  actor: VerificationActor;
  contract: HumanAssistanceContract | null;
  session: string;
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
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  if (plan.kind === "click") {
    await deps.clickTarget(input.session, contract!, plan.targetId);
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  if (plan.kind === "unsolvable") {
    await deps.finalizeFailed("Verification challenge cannot be solved.");
    return { kind: "failed" };
  }
  let outcome: SolveOutcome;
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
      captureChallengeImage: () =>
        deps.captureChallengeImage(input.session, contract!),
      injectAnswer: (answer) =>
        deps.injectAnswer(input.session, contract!, answer),
      injectSelections: (selections) =>
        deps.injectSelections(input.session, contract!, selections),
      validateChallengeImage: deps.validateChallengeImage
        ? () => deps.validateChallengeImage!(input.session, contract!)
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
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  await deps.finalizeFailed("Verification solver exhausted its attempts.");
  return { kind: "failed" };
}

export async function routeWaitingRunVerification(input: {
  taskId: string;
  taskRunId: string;
  db: LedgerDatabase;
  scheduleResume: (session: string) => void;
  solver?: VerificationSolver;
  captureChallengeImage?: VerificationRoutingDependencies["captureChallengeImage"];
  validateChallengeImage?: VerificationRoutingDependencies["validateChallengeImage"];
  injectAnswer?: VerificationRoutingDependencies["injectAnswer"];
  injectSelections?: VerificationRoutingDependencies["injectSelections"];
  clickTarget?: VerificationRoutingDependencies["clickTarget"];
  finalizeFailed?: VerificationRoutingDependencies["finalizeFailed"];
  providerVerification?: VerificationChallengeImageProvider;
  genericCaptureChallengeImage?: VerificationRoutingDependencies["captureChallengeImage"];
  settings?: AutomationSettingsFile;
}): Promise<VerificationRoutingOutcome> {
  const task = taskById(input.taskId);
  const group = task?.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  const settings = input.settings ?? readAutomationSettings();
  const actor = verificationActorForSource(group?.verificationActorKey, settings);
  if (actor !== "solver") return { kind: "human" };

  const run = taskRunById(input.db, input.taskRunId);
  if (!run) return { kind: "human" };
  const contract = run.humanAssistanceContract;
  const session = sessionFromRun(run);

  const finalizeFailed =
    input.finalizeFailed ??
    ((message: string) => finalizeFailedWaitingRun(input.db, run, message));

  if (!session) {
    await finalizeFailed("Verification solver could not resolve the session.");
    return { kind: "failed" };
  }

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
    ? async (selectedSession: string, selectedContract: HumanAssistanceContract) => {
        const image = await capture(selectedSession, selectedContract);
        if (image === null) throw new ProviderChallengeImageCaptureError();
        return image;
      }
    : capture;

  const dependencies: VerificationRoutingDependencies = {
    solver: input.solver ?? defaultLocalSolver,
    captureChallengeImage: selectedCapture,
    validateChallengeImage: input.validateChallengeImage
      ?? imageSelection.validateChallengeImage,
    injectAnswer: input.injectAnswer ?? injectVerificationAnswer,
    injectSelections: input.injectSelections ?? injectVerificationSelections,
    clickTarget: input.clickTarget ?? clickVerificationTarget,
    resume: (session) => {
      input.scheduleResume(session);
    },
    finalizeFailed,
  };

  return routeVerificationActor({
    actor,
    contract,
    session,
    confidenceThreshold,
    dependencies,
  });
}
