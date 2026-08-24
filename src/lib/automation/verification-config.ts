import type { VerificationChallengeKind } from "./human-assistance.ts";

export const VERIFICATION_ACTORS = ["human", "solver"] as const;

export type VerificationActor = typeof VERIFICATION_ACTORS[number];

export const DEFAULT_VERIFICATION_ACTOR: VerificationActor = "human";

export const DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD = 0.9;

export type SolverChallengeKind = Exclude<VerificationChallengeKind, "checkbox">;

export function isSolverChallengeKind(
  kind: VerificationChallengeKind | undefined,
): kind is SolverChallengeKind {
  return kind === "text-captcha" || kind === "image-selection";
}

export const VERIFICATION_CONFIDENCE_THRESHOLD_KEYS: Record<
  SolverChallengeKind,
  string
> = {
  "text-captcha": "VERIFICATION_TEXT_CAPTCHA_CONFIDENCE_THRESHOLD",
  "image-selection": "VERIFICATION_IMAGE_SELECTION_CONFIDENCE_THRESHOLD",
};

type VerificationSettings = Record<string, string | boolean | undefined>;

export function verificationActorForSource(
  verificationActorKey: string | undefined,
  settings: VerificationSettings,
): VerificationActor {
  if (verificationActorKey === undefined) return DEFAULT_VERIFICATION_ACTOR;
  const raw = settings[verificationActorKey];
  if (raw === undefined) return DEFAULT_VERIFICATION_ACTOR;
  const value = String(raw).trim().toLowerCase();
  return VERIFICATION_ACTORS.includes(value as VerificationActor)
    ? (value as VerificationActor)
    : DEFAULT_VERIFICATION_ACTOR;
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
