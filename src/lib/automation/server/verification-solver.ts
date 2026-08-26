import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrAttemptStrategy,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
  HumanAssistanceContract,
  SolveAcceptancePolicy,
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
  solveAcceptancePolicy?: SolveAcceptancePolicy;
  expectedAnswerLength?: number;
};

export type SolveOutcome =
  | { status: "solved" }
  | { status: "absent" }
  | { status: "exhausted" };

type PlannedCandidate = {
  result: VerificationSolverResult;
  attempt: number;
  strategyFingerprint: string;
};

function isStructurallyValid(
  result: VerificationSolverResult,
  deps: Pick<SolveDependencies, "charset" | "expectedAnswerLength">,
): boolean {
  if (!Number.isFinite(result.confidence)) return false;
  if ("selections" in result) return result.selections.length > 0;
  if (!result.answer) return false;
  if (
    deps.expectedAnswerLength !== undefined
    && result.answer.length !== deps.expectedAnswerLength
  ) return false;
  if (deps.charset === "digits" && !/^\d+$/.test(result.answer)) return false;
  return true;
}

function strategyFingerprint(
  deps: Pick<
    SolveDependencies,
    "imagePreprocessing" | "ocrPageSegmentationMode"
  >,
  strategy: CaptchaOcrAttemptStrategy,
): string {
  return JSON.stringify({
    imagePreprocessing: strategy.imagePreprocessing
      ?? deps.imagePreprocessing
      ?? [],
    ocrPageSegmentationMode: strategy.ocrPageSegmentationMode
      ?? deps.ocrPageSegmentationMode
      ?? "single-line",
    ocrOutputStage: strategy.ocrOutputStage ?? "final",
  });
}

function confidenceEvidence(
  candidates: readonly PlannedCandidate[],
  threshold: number,
  rejectConflictingTies: boolean,
): { candidate: PlannedCandidate | null; ambiguous: boolean } {
  const eligible = candidates.filter(({ result }) =>
    result.confidence >= threshold
  );
  if (eligible.length === 0) return { candidate: null, ambiguous: false };
  const highestConfidence = Math.max(
    ...eligible.map(({ result }) => result.confidence),
  );
  const highest = eligible.filter(({ result }) =>
    result.confidence === highestConfidence
  );
  if (
    rejectConflictingTies
    && new Set(highest.map(({ result }) =>
      "answer" in result ? result.answer : JSON.stringify(result.selections)
    )).size > 1
  ) {
    return { candidate: null, ambiguous: true };
  }
  return { candidate: highest[0]!, ambiguous: false };
}

function agreementEvidence(
  candidates: readonly PlannedCandidate[],
): { candidate: PlannedCandidate | null; ambiguous: boolean } {
  const groups = new Map<string, PlannedCandidate[]>();
  for (const candidate of candidates) {
    if (!("answer" in candidate.result)) continue;
    const group = groups.get(candidate.result.answer) ?? [];
    if (!group.some(({ strategyFingerprint: fingerprint }) =>
      fingerprint === candidate.strategyFingerprint
    )) group.push(candidate);
    groups.set(candidate.result.answer, group);
  }
  const agreements = [...groups.values()].filter((group) => group.length >= 2);
  if (agreements.length === 0) return { candidate: null, ambiguous: false };
  if (agreements.length > 1) return { candidate: null, ambiguous: true };
  const winner = agreements[0]!.reduce((best, candidate) =>
    candidate.result.confidence > best.result.confidence ? candidate : best
  );
  return { candidate: winner, ambiguous: false };
}

function acceptedPlannedCandidate(
  candidates: readonly PlannedCandidate[],
  deps: Pick<
    SolveDependencies,
    "challengeKind" | "confidenceThreshold" | "solveAcceptancePolicy"
  >,
): PlannedCandidate | null {
  const policy = deps.solveAcceptancePolicy;
  if (!policy || policy.mode === "confidence-only") {
    return confidenceEvidence(candidates, deps.confidenceThreshold, false)
      .candidate;
  }
  if (deps.challengeKind !== "text-captcha") {
    throw new Error("OCR agreement requires a text CAPTCHA challenge.");
  }
  if (policy.mode === "agreement-only") {
    const agreement = agreementEvidence(candidates);
    return agreement.ambiguous ? null : agreement.candidate;
  }
  const confidence = confidenceEvidence(
    candidates,
    deps.confidenceThreshold,
    true,
  );
  const agreement = agreementEvidence(candidates);
  if (agreement.ambiguous) return null;
  if (confidence.ambiguous) {
    return policy.conflictResolution === "prefer-agreement"
      ? agreement.candidate
      : null;
  }
  if (!confidence.candidate) return agreement.candidate;
  if (!agreement.candidate) return confidence.candidate;
  const confidenceAnswer = "answer" in confidence.candidate.result
    ? confidence.candidate.result.answer
    : null;
  const agreementAnswer = "answer" in agreement.candidate.result
    ? agreement.candidate.result.answer
    : null;
  if (confidenceAnswer === agreementAnswer) return confidence.candidate;
  if (policy.conflictResolution === "prefer-agreement") {
    return agreement.candidate;
  }
  if (policy.conflictResolution === "prefer-confidence") {
    return confidence.candidate;
  }
  return null;
}

export async function solveVerificationChallenge(
  deps: SolveDependencies,
): Promise<SolveOutcome> {
  const plannedAttempts = deps.ocrAttemptPlan;
  if (
    deps.solveAcceptancePolicy !== undefined
    && deps.solveAcceptancePolicy.mode !== "confidence-only"
    && (!plannedAttempts || plannedAttempts.length < 2)
  ) {
    throw new Error("OCR agreement requires at least two distinct strategies.");
  }
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

  const isEligible = (result: VerificationSolverResult) =>
    isStructurallyValid(result, deps)
    && result.confidence >= deps.confidenceThreshold;

  if (plannedAttempts) {
    const candidates: PlannedCandidate[] = [];
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const strategy = plannedAttempts[attempt - 1]!;
      const result = await deps.solver.solve({
        image: capturedImage!,
        attempt,
        strategy,
        challengeKind: deps.challengeKind,
        prompt: deps.prompt,
        charset: deps.charset,
        imagePreprocessing: deps.imagePreprocessing,
        ocrPageSegmentationMode: deps.ocrPageSegmentationMode,
        expectedAnswerLength: deps.expectedAnswerLength,
      });
      if (!isStructurallyValid(result, deps)) continue;
      candidates.push({
        result,
        attempt,
        strategyFingerprint: strategyFingerprint(deps, strategy),
      });
    }
    const winner = acceptedPlannedCandidate(candidates, deps);
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
