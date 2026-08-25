import type {
  CaptchaImagePreprocessingMode,
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
    challengeKind: SolverChallengeKind;
    prompt?: string;
    charset?: ChallengeCharacterSet;
    imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
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
  injectAnswer: (answer: string) => Promise<void>;
  injectSelections?: (
    selections: readonly VerificationSelectionPoint[],
  ) => Promise<void>;
  prompt?: string;
  charset?: ChallengeCharacterSet;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
};

export type SolveOutcome =
  | { status: "solved" }
  | { status: "absent" }
  | { status: "exhausted" };

export async function solveVerificationChallenge(
  deps: SolveDependencies,
): Promise<SolveOutcome> {
  for (let attempt = 1; attempt <= MAX_SOLVE_ATTEMPTS; attempt += 1) {
    const image = await deps.captureChallengeImage();
    if (image === null) return { status: "absent" };
    const result = await deps.solver.solve({
      image,
      challengeKind: deps.challengeKind,
      prompt: deps.prompt,
      charset: deps.charset,
      imagePreprocessing: deps.imagePreprocessing,
    });
    if (result.confidence < deps.confidenceThreshold) continue;
    if ("selections" in result) {
      if (result.selections.length === 0) continue;
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
