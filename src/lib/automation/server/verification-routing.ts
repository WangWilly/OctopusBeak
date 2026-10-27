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
  type SolveDependencies,
  type SolveOutcome,
  type VerificationSolver,
} from "./verification-solver.ts";
import { localVerificationSolver } from "./local-verification-solver.ts";
import { automationViewer, type PageForRun } from "./automation-viewer.ts";
import { createProviderVerificationHost } from "./provider-verification.ts";
import { taskById } from "./tasks.ts";
import { VERIFIED_SOURCES } from "./sources/index.ts";
import { readAutomationSettings } from "./settings.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";

/** What the provider made of a submitted answer once the workflow resumed. */
export type VerificationPostSubmitOutcome =
  | "none"
  | "provider-rejected"
  | "unrecognized-dialog";

/**
 * What a caller supplies to route one verification stage. Everything that
 * touches the page comes from the Provider verification adapter resolved for
 * the contract, over `pageForRun`.
 */
export type VerificationRoutingSeams = {
  /** Finds the page the run's current Workflow execution hosts. */
  pageForRun: PageForRun;
  solver: VerificationSolver;
  /** Continues the paused workflow once the stage is answered. */
  resume: () => void | Promise<void>;
  /**
   * Called after `resume` only when the route submitted an answer (or found
   * no challenge): what the provider made of it. A workflow that proves the
   * rejection itself reports it here once its execution settles.
   */
  postSubmitOutcome: () => Promise<VerificationPostSubmitOutcome>;
  finalizeFailed: (message: string) => void | Promise<void>;
  /** Called once after a non-empty challenge has been captured. */
  onChallengeCaptured: () => void | Promise<void>;
};

/** The App's local solver, shared by every route that has no other. */
export const appVerificationSolver: VerificationSolver = localVerificationSolver();

/** Reports "none" for a workflow that does not prove a CAPTCHA rejection itself. */
export const noPostSubmitOutcome = async (): Promise<VerificationPostSubmitOutcome> => "none";

export const MAX_CHALLENGES_PER_ROUND = 5;

/**
 * Solve up to `budget` challenges within one round, refreshing between them.
 * The first solved or absent outcome ends the round so the caller submits at
 * most once; a refresh that reports no new challenge exhausts the round.
 */
export async function solveChallengeRound(input: {
  budget: number;
  solveOnce: () => Promise<SolveOutcome>;
  refresh?: () => Promise<boolean>;
}): Promise<SolveOutcome> {
  for (let challenge = 1; challenge <= input.budget; challenge += 1) {
    const outcome = await input.solveOnce();
    if (outcome.status !== "exhausted") return outcome;
    if (challenge === input.budget || !input.refresh || !await input.refresh()) break;
  }
  return { status: "exhausted" };
}

class ProviderChallengeCaptureError extends Error {
  constructor(media: "image" | "audio") {
    super(`Verification challenge ${media} capture failed.`);
    this.name = "ProviderChallengeCaptureError";
  }
}

type ChallengeSteps = {
  captureChallengeImage: () => Promise<Buffer | null>;
  captureChallengeAudio: () => Promise<Buffer | null>;
  validateChallengeImage?: () => Promise<boolean>;
  /** Present only when the challenge-image owner declares an In-page CAPTCHA Refresh. */
  refreshChallenge?: () => Promise<boolean>;
  injectAnswer: SolveDependencies["injectAnswer"];
  injectSelections: NonNullable<SolveDependencies["injectSelections"]>;
  clickTarget: (targetId: string) => Promise<void>;
};

/**
 * Bind one contract's page steps. A provider that owns the challenge media is
 * authoritative: a failed capture is a hard failure and never falls through
 * to the generic contract-rectangle screenshot. Contracts without an owner
 * keep the generic viewer behaviour.
 */
function challengeSteps(
  contract: HumanAssistanceContract,
  taskRunId: string,
  pageForRun: PageForRun,
): ChallengeSteps {
  const viewer = automationViewer(pageForRun);
  const provider = createProviderVerificationHost({ pageForRun });
  const required = (media: "image" | "audio", capture: () => Promise<Buffer | null>) => async () => {
    const bytes = await capture();
    if (bytes === null) throw new ProviderChallengeCaptureError(media);
    return bytes;
  };
  const imageOwned = provider.handlesChallengeImage(contract);
  const captureImage = () => provider.captureChallengeImage(taskRunId, contract);
  const captureAudio = () => provider.captureChallengeAudio(taskRunId, contract);
  return {
    captureChallengeImage: imageOwned
      ? required("image", captureImage)
      : () => viewer.captureChallengeImage(taskRunId, contract),
    validateChallengeImage: imageOwned
      ? () => provider.isChallengeImageCurrent(taskRunId, contract)
      : undefined,
    refreshChallenge: imageOwned && provider.refreshesChallengeImage(contract)
      ? () => provider.refreshChallengeImage(taskRunId, contract)
      : undefined,
    captureChallengeAudio: provider.handlesChallengeAudio(contract)
      ? required("audio", captureAudio)
      : captureAudio,
    injectAnswer: (answer) => provider.injectAnswer(taskRunId, contract, answer),
    injectSelections: (selections) => viewer.injectSelections(taskRunId, contract, selections),
    clickTarget: (targetId) => provider.clickTarget(taskRunId, contract, targetId),
  };
}

export type VerificationRoutingOutcome =
  | { kind: "resumed" }
  | { kind: "failed" }
  | {
    kind: "retryable";
    reason: "solver-exhausted" | "provider-rejected";
  };

const verificationOf = (taskId: string) =>
  VERIFIED_SOURCES.find((source) => source.task.id === taskId)?.workflow.verification;

/** App browser workflows whose verification stages reach the solver route. */
export function appWorkflowRoutesVerification(taskId: string) {
  return verificationOf(taskId) !== undefined;
}

/** The source's own Verification route, when it replaces the generic solver route. */
export function sourceVerificationRoute(taskId: string) {
  return verificationOf(taskId)?.route;
}

/**
 * These providers classify submission results inside the workflow. Join the
 * completed execution instead of racing a second owner of browser dialogs.
 */
export const WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS: ReadonlySet<string> = new Set(
  VERIFIED_SOURCES.filter((source) => source.workflow.verification?.rejection !== undefined).map((source) => source.task.id),
);

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
  seams: VerificationRoutingSeams;
}): Promise<VerificationRoutingOutcome> {
  const contract = input.contract;
  const plan = verificationPlanForContract(contract);
  const seams = input.seams;
  if (plan.kind === "proceed") {
    await seams.resume();
    return { kind: "resumed" };
  }
  const steps = challengeSteps(contract!, input.taskRunId, seams.pageForRun);
  if (plan.kind === "click") {
    await steps.clickTarget(plan.targetId);
    await seams.resume();
    return { kind: "resumed" };
  }
  if (plan.kind === "unsolvable") {
    await seams.finalizeFailed("Verification challenge cannot be solved.");
    return { kind: "failed" };
  }
  let outcome: SolveOutcome;
  let challengeCaptured = false;
  const noteCaptured = async (media: Buffer | null) => {
    if (media !== null && !challengeCaptured) {
      challengeCaptured = true;
      await seams.onChallengeCaptured();
    }
    return media;
  };
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
    const solveDependencies: SolveDependencies = {
      challengeKind: plan.challengeKind,
      confidenceThreshold:
        contract?.solverConfidenceThreshold
        ?? input.confidenceThreshold
        ?? DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD,
      solver: seams.solver,
      captureChallengeImage: async () => noteCaptured(await steps.captureChallengeImage()),
      captureChallengeAudio: async () => noteCaptured(await steps.captureChallengeAudio()),
      injectAnswer: steps.injectAnswer,
      injectSelections: steps.injectSelections,
      validateChallengeImage: steps.validateChallengeImage,
      ...solverMetadata,
    };
    const refreshChallenge = steps.refreshChallenge;
    outcome = await solveChallengeRound({
      budget: refreshChallenge ? MAX_CHALLENGES_PER_ROUND : 1,
      solveOnce: () => solveVerificationChallenge(solveDependencies),
      refresh: refreshChallenge,
    });
  } catch (error) {
    await seams.finalizeFailed(
      error instanceof ProviderChallengeCaptureError
        ? error.message
        : "Verification solver failed to solve the challenge.",
    );
    return { kind: "failed" };
  }
  if (outcome.status === "solved" || outcome.status === "absent") {
    await seams.resume();
    const postSubmitOutcome = await seams.postSubmitOutcome();
    if (postSubmitOutcome === "provider-rejected") {
      return { kind: "retryable", reason: "provider-rejected" };
    }
    if (postSubmitOutcome === "unrecognized-dialog") {
      await seams.finalizeFailed("Provider login dialog was not recognized.");
      return { kind: "failed" };
    }
    return { kind: "resumed" };
  }
  return { kind: "retryable", reason: "solver-exhausted" };
}

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

export async function routeWaitingRunVerification(input: VerificationRoutingSeams & {
  /** The run whose current human assistance stage this routes. */
  run: Pick<ActiveAutomationTaskRun, "taskId" | "taskRunId" | "current">;
  settings?: AutomationSettingsFile;
}): Promise<VerificationRoutingOutcome> {
  const { run: activeRun, settings: givenSettings, ...seams } = input;
  const task = taskById(activeRun.taskId);
  if (!task?.workflowId) {
    await seams.finalizeFailed("Verification routing requires an App browser workflow.");
    return { kind: "failed" };
  }
  const settings = givenSettings ?? readAutomationSettings();
  const run = activeRun.current();
  if (run.status !== "waiting_for_human" || !run.humanAssistanceContract) {
    await seams.finalizeFailed("App workflow verification stage is unavailable.");
    return { kind: "failed" };
  }
  const contract = run.humanAssistanceContract;
  return routeVerificationActor({
    contract,
    taskRunId: activeRun.taskRunId,
    confidenceThreshold: verificationConfidenceThreshold(contract, settings),
    seams,
  });
}
