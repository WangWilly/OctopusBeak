import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrAttemptStrategy,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
  HumanAssistanceContract,
} from "../human-assistance.ts";
import {
  isSolverChallengeKind,
  type SolverChallengeKind,
} from "../verification-config.ts";

export const MAX_SOLVE_ATTEMPTS = 3;

export type VerificationSelectionPoint = {
  x: number;
  y: number;
};

export type TextVerificationAnswer = {
  answer: string;
  confidence: number;
};

export type SelectionVerificationAnswer = {
  selections: readonly VerificationSelectionPoint[];
  confidence: number;
};

export type VerificationSolverResult =
  | TextVerificationAnswer
  | SelectionVerificationAnswer;

export type VerificationSolver = {
  solve(input: {
    image: Buffer;
    attempt?: number;
    strategy?: CaptchaOcrAttemptStrategy;
    challengeKind: SolverChallengeKind;
    prompt?: string;
    charset?: ChallengeCharacterSet;
    imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
    ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode;
    expectedAnswerLength?: number;
  }): Promise<VerificationSolverResult>;
};

export type VerificationPlan =
  | { kind: "solve"; challengeKind: SolverChallengeKind }
  | { kind: "click"; targetId: string }
  | { kind: "unsolvable" }
  | { kind: "proceed" };

export function verificationPlanForContract(
  contract: HumanAssistanceContract | null,
): VerificationPlan {
  if (!contract) return { kind: "proceed" };
  const kind = contract.challengeKind;
  if (kind === "checkbox") {
    const target = contract.targets.find((candidate) =>
      candidate.modes.includes("click"),
    );
    return target ? { kind: "click", targetId: target.id } : { kind: "proceed" };
  }
  if (isSolverChallengeKind(kind)) {
    return contract.challengeImageRegion
      ? { kind: "solve", challengeKind: kind }
      : { kind: "unsolvable" };
  }
  return { kind: "proceed" };
}

export type SolveDependencies = {
  challengeKind: SolverChallengeKind;
  confidenceThreshold: number;
  solver: VerificationSolver;
  captureChallengeImage: () => Promise<Buffer | null>;
  /** Re-checks provider-owned source pixels immediately before injection. */
  validateChallengeImage?: () => Promise<boolean>;
  injectAnswer: (answer: string) => Promise<void>;
  injectSelections?: (
    selections: readonly VerificationSelectionPoint[],
  ) => Promise<void>;
  prompt?: string;
  charset?: ChallengeCharacterSet;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
  ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode;
  ocrAttemptPlan?: readonly CaptchaOcrAttemptStrategy[];
  expectedAnswerLength?: number;
};

export type SolveOutcome =
  | { status: "solved" }
  | { status: "absent" }
  | { status: "exhausted" };

export async function solveVerificationChallenge(
  deps: SolveDependencies,
): Promise<SolveOutcome> {
  const plannedAttempts = deps.ocrAttemptPlan;
  let capturedImage: Buffer | null = null;
  if (plannedAttempts) {
    // A declared plan describes alternative OCR views of one challenge. The
    // generic host has no safe way to refresh a provider CAPTCHA, so reuse the
    // captured bytes and never pretend a repeated screenshot is a new puzzle.
    capturedImage = await deps.captureChallengeImage();
    if (capturedImage === null) return { status: "absent" };
  }
  const attemptCount = Math.min(
    plannedAttempts?.length ?? MAX_SOLVE_ATTEMPTS,
    MAX_SOLVE_ATTEMPTS,
  );

  const isEligible = (result: VerificationSolverResult) => {
    if (!Number.isFinite(result.confidence) || result.confidence < deps.confidenceThreshold) {
      return false;
    }
    if ("selections" in result) return result.selections.length > 0;
    if (!result.answer) return false;
    if (deps.expectedAnswerLength !== undefined
      && result.answer.length !== deps.expectedAnswerLength) {
      return false;
    }
    if (deps.charset === "digits" && !/^\d+$/.test(result.answer)) return false;
    return true;
  };

  if (plannedAttempts) {
    let winner: { result: VerificationSolverResult; attempt: number } | null = null;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const result = await deps.solver.solve({
        image: capturedImage!,
        attempt,
        strategy: plannedAttempts[attempt - 1],
        challengeKind: deps.challengeKind,
        prompt: deps.prompt,
        charset: deps.charset,
        imagePreprocessing: deps.imagePreprocessing,
        ocrPageSegmentationMode: deps.ocrPageSegmentationMode,
        expectedAnswerLength: deps.expectedAnswerLength,
      });
      if (!isEligible(result)) continue;
      if (!winner || result.confidence > winner.result.confidence) {
        winner = { result, attempt };
      }
    }
    if (!winner) return { status: "exhausted" };
    if (deps.validateChallengeImage && !await deps.validateChallengeImage()) {
      return { status: "exhausted" };
    }
    if ("selections" in winner.result) {
      if (!deps.injectSelections) {
        throw new Error(
          "Verification solver returned a selection answer but no selection injection is available.",
        );
      }
      await deps.injectSelections(winner.result.selections);
    } else {
      await deps.injectAnswer(winner.result.answer);
    }
    return { status: "solved" };
  }

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const image = await deps.captureChallengeImage();
    if (image === null) return { status: "absent" };
    const result = await deps.solver.solve({
      image,
      attempt,
      challengeKind: deps.challengeKind,
      prompt: deps.prompt,
      charset: deps.charset,
      imagePreprocessing: deps.imagePreprocessing,
      ocrPageSegmentationMode: deps.ocrPageSegmentationMode,
      expectedAnswerLength: deps.expectedAnswerLength,
    });
    if (!isEligible(result)) continue;
    if ("selections" in result) {
      if (!deps.injectSelections) {
        throw new Error(
          "Verification solver returned a selection answer but no selection injection is available.",
        );
      }
      await deps.injectSelections(result.selections);
    } else {
      await deps.injectAnswer(result.answer);
    }
    return { status: "solved" };
  }
  return { status: "exhausted" };
}
