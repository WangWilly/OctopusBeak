/**
 * The actor-neutral rules for deciding whether OCR candidates may be
 * submitted.  Verification contracts declare one of these policies, while
 * the solver asks this module to apply it to its candidates.
 */

export const SOLVE_CONFLICT_RESOLUTIONS = [
  "reject",
  "prefer-agreement",
  "prefer-confidence",
] as const;

export type SolveConflictResolution = typeof SOLVE_CONFLICT_RESOLUTIONS[number];

export type SolveAcceptancePolicy =
  | { mode: "confidence-only" }
  | { mode: "agreement-only" }
  | {
    mode: "confidence-or-agreement";
    conflictResolution: SolveConflictResolution;
  };

export type SolveAcceptanceCandidate<T> = {
  value: T;
  confidence: number;
  strategyFingerprint: string;
};

export type SolveAcceptanceResult<T> = {
  candidate: SolveAcceptanceCandidate<T> | null;
  ambiguous: boolean;
};

export type SolveAcceptanceValidationOptions = {
  challengeKind?: string;
  strategyCount?: number;
  errorPrefix?: string;
};

/**
 * Validate policy configuration at the contract seam and again at the
 * runtime seam. Keeping this rule here prevents the two callers from drifting
 * apart as new policy modes are introduced.
 */
export function assertSolveAcceptancePolicy(
  policy: unknown,
  options: SolveAcceptanceValidationOptions = {},
): asserts policy is SolveAcceptancePolicy {
  const prefix = options.errorPrefix ?? "Invalid solve acceptance policy";
  if (!policy || typeof policy !== "object") {
    throw new Error(`${prefix}: solve acceptance policy must be an object.`);
  }
  const candidate = policy as {
    mode?: unknown;
    conflictResolution?: unknown;
  };
  if (candidate.mode === "confidence-only") {
    if ("conflictResolution" in candidate) {
      throw new Error(
        `${prefix}: confidence-only policy cannot declare conflict resolution.`,
      );
    }
    return;
  }
  if (candidate.mode === "agreement-only") {
    if ("conflictResolution" in candidate) {
      throw new Error(
        `${prefix}: agreement-only policy cannot declare conflict resolution.`,
      );
    }
    assertAgreementConfiguration(options, prefix);
    return;
  }
  if (candidate.mode === "confidence-or-agreement") {
    if (!SOLVE_CONFLICT_RESOLUTIONS.includes(candidate.conflictResolution as SolveConflictResolution)) {
      throw new Error(
        `${prefix}: unknown solve conflict resolution ${candidate.conflictResolution}.`,
      );
    }
    assertAgreementConfiguration(options, prefix);
    return;
  }
  throw new Error(
    `${prefix}: unknown solve acceptance policy ${candidate.mode}.`,
  );
}

function assertAgreementConfiguration(
  options: SolveAcceptanceValidationOptions,
  prefix: string,
) {
  if (options.challengeKind !== "text-captcha") {
    throw new Error(`${prefix}: OCR agreement requires a text CAPTCHA challenge.`);
  }
  if (options.strategyCount !== undefined && options.strategyCount < 2) {
    throw new Error(`${prefix}: OCR agreement requires at least two distinct strategies.`);
  }
}

export type SolveAcceptanceSelectionOptions<T> = {
  confidenceThreshold: number;
  /** Declared OCR strategy count, distinct from candidates that survived validation. */
  strategyCount?: number;
  /** Stable identity used only for resolving equal-confidence ties. */
  identityKey: (value: T) => string;
  /** Return null for candidate kinds that cannot establish agreement. */
  agreementKey: (value: T) => string | null;
  challengeKind?: string;
};

function confidenceEvidence<T>(
  candidates: readonly SolveAcceptanceCandidate<T>[],
  threshold: number,
  rejectConflictingTies: boolean,
  identityKey: (value: T) => string,
): SolveAcceptanceResult<T> {
  const eligible = candidates.filter(({ confidence }) => confidence >= threshold);
  if (eligible.length === 0) return { candidate: null, ambiguous: false };
  const highestConfidence = Math.max(...eligible.map(({ confidence }) => confidence));
  const highest = eligible.filter(({ confidence }) => confidence === highestConfidence);
  if (
    rejectConflictingTies
    && new Set(highest.map(({ value }) => identityKey(value))).size > 1
  ) {
    return { candidate: null, ambiguous: true };
  }
  return { candidate: highest[0]!, ambiguous: false };
}

function agreementEvidence<T>(
  candidates: readonly SolveAcceptanceCandidate<T>[],
  agreementKey: (value: T) => string | null,
): SolveAcceptanceResult<T> {
  const groups = new Map<string, SolveAcceptanceCandidate<T>[]>();
  for (const candidate of candidates) {
    const key = agreementKey(candidate.value);
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    if (!group.some(({ strategyFingerprint }) =>
      strategyFingerprint === candidate.strategyFingerprint
    )) group.push(candidate);
    groups.set(key, group);
  }
  const agreements = [...groups.values()].filter((group) => group.length >= 2);
  if (agreements.length === 0) return { candidate: null, ambiguous: false };
  if (agreements.length > 1) return { candidate: null, ambiguous: true };
  const candidate = agreements[0]!.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  );
  return { candidate, ambiguous: false };
}

/**
 * Apply a declared policy to candidates from one challenge image. Candidate
 * order is significant only for an unresolved equal-confidence tie, matching
 * the ordered OCR attempt plan and preserving current behavior.
 */
export function selectAcceptedSolveCandidate<T>(
  candidates: readonly SolveAcceptanceCandidate<T>[],
  policy: SolveAcceptancePolicy | undefined,
  options: SolveAcceptanceSelectionOptions<T>,
): SolveAcceptanceResult<T> {
  const effectivePolicy = policy ?? { mode: "confidence-only" };
  assertSolveAcceptancePolicy(effectivePolicy, {
    challengeKind: options.challengeKind,
    strategyCount: options.strategyCount,
  });

  if (effectivePolicy.mode === "confidence-only") {
    return confidenceEvidence(
      candidates,
      options.confidenceThreshold,
      false,
      options.identityKey,
    );
  }

  const agreement = agreementEvidence(candidates, options.agreementKey);
  if (effectivePolicy.mode === "agreement-only") {
    return agreement.ambiguous ? { candidate: null, ambiguous: true } : agreement;
  }

  const confidence = confidenceEvidence(
    candidates,
    options.confidenceThreshold,
    true,
    options.identityKey,
  );
  if (agreement.ambiguous) return { candidate: null, ambiguous: true };
  if (confidence.ambiguous) {
    return effectivePolicy.conflictResolution === "prefer-agreement"
      ? agreement
      : { candidate: null, ambiguous: true };
  }
  if (!confidence.candidate) return agreement;
  if (!agreement.candidate) return confidence;

  const confidenceKey = options.agreementKey(confidence.candidate.value);
  const agreementKey = options.agreementKey(agreement.candidate.value);
  if (confidenceKey !== null && confidenceKey === agreementKey) return confidence;
  if (effectivePolicy.conflictResolution === "prefer-agreement") return agreement;
  if (effectivePolicy.conflictResolution === "prefer-confidence") return confidence;
  return { candidate: null, ambiguous: true };
}
