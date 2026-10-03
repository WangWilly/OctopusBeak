import type { VerificationChallengeKind } from "./human-assistance.ts";

export const VERIFICATION_ACTORS = ["human", "solver"] as const;

export type VerificationActor = typeof VERIFICATION_ACTORS[number];

export const DEFAULT_VERIFICATION_ACTOR: VerificationActor = "solver";

export const DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD = 0.9;

export type SolverChallengeKind = Exclude<VerificationChallengeKind, "checkbox">;

export function isSolverChallengeKind(
  kind: VerificationChallengeKind | undefined,
): kind is SolverChallengeKind {
  return kind === "text-captcha" || kind === "image-selection"
    || kind === "audio-captcha";
}

export const VERIFICATION_CONFIDENCE_THRESHOLD_KEYS: Record<
  SolverChallengeKind,
  string
> = {
  "text-captcha": "VERIFICATION_TEXT_CAPTCHA_CONFIDENCE_THRESHOLD",
  "image-selection": "VERIFICATION_IMAGE_SELECTION_CONFIDENCE_THRESHOLD",
  "audio-captcha": "VERIFICATION_AUDIO_CAPTCHA_CONFIDENCE_THRESHOLD",
};

type VerificationSettings = Record<string, string | boolean | undefined>;

export type VerificationActorPolicyInput = {
  /** Must come from Electron's `app.isPackaged`, never NODE_ENV or renderer input. */
  isPackaged: boolean;
  /** Snapshot of the process environment captured before loading development .env files. */
  env: Readonly<Record<string, string | undefined>>;
};

/**
 * Resolve the effective actor from trusted host launch context. Saved settings
 * are deliberately not accepted here: they can describe configuration, but
 * cannot authorize manual control of a verification run.
 */
export function effectiveVerificationActorForSourceKey(
  verificationActorKey: string | undefined,
  policy: VerificationActorPolicyInput,
): VerificationActor {
  if (!verificationActorKey || policy.isPackaged !== false) {
    return DEFAULT_VERIFICATION_ACTOR;
  }
  const value = policy.env[verificationActorKey]?.trim().toLowerCase();
  return value === "human" ? "human" : DEFAULT_VERIFICATION_ACTOR;
}

let hostVerificationActorPolicy: VerificationActorPolicyInput = Object.freeze({
  isPackaged: true,
  env: Object.freeze({}),
});

/** Install the policy once from Electron main before starting runtime work. */
export function configureHostVerificationActorPolicy(
  policy: VerificationActorPolicyInput,
) {
  hostVerificationActorPolicy = Object.freeze({
    isPackaged: policy.isPackaged,
    env: Object.freeze({ ...policy.env }),
  });
}

/** Resolve a source actor from the immutable Electron startup policy. */
export function hostVerificationActorForSourceKey(
  verificationActorKey: string | undefined,
): VerificationActor {
  return effectiveVerificationActorForSourceKey(
    verificationActorKey,
    hostVerificationActorPolicy,
  );
}

export function challengeConfidenceThreshold(
  settings: VerificationSettings,
  kind: SolverChallengeKind,
): number | undefined {
  const raw = settings[VERIFICATION_CONFIDENCE_THRESHOLD_KEYS[kind]];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
