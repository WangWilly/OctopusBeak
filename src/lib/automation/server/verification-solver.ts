import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  isSolverChallengeKind,
  type SolverChallengeKind,
} from "../verification-config.ts";

export const MAX_SOLVE_ATTEMPTS = 3;

export type VerificationSolverResult = {
  answer: string;
  confidence: number;
};

export type VerificationSolver = {
  solve(input: {
    image: Buffer;
    challengeKind: SolverChallengeKind;
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
    });
    if (result.confidence < deps.confidenceThreshold) continue;
    await deps.injectAnswer(result.answer);
    return { status: "solved" };
  }
  return { status: "exhausted" };
}
