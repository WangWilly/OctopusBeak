import type { VerificationActor } from "./verification-config.ts";
import type { WorkflowRunEvent } from "./workflow-executor.ts";
import type { CathayAppVerificationFailureReason } from "./verification-errors.ts";
import type { OnboardingStep } from "$lib/onboarding/progression.ts";

export const CATHAY_APP_VERIFICATION_FAILURE_REASONS = [
  "challenge-unavailable",
  "answer-entry-failed",
  "send-uncertain",
  "submission-uncertain",
  "completion-unconfirmed",
  "gmail-disabled",
  "gmail-not-configured",
  "gmail-needs-authorization",
  "gmail-authorization-cancelled",
  "gmail-authorization-failed",
  "gmail-token-invalid",
  "gmail-request-failed",
  "gmail-no-candidate",
  "gmail-ambiguous-candidate",
  "gmail-stale-candidate",
  "gmail-malformed-candidate",
  "gmail-unauthenticated-candidate",
  "gmail-unauthenticated-google-results",
  "gmail-unauthenticated-cathay-alignment",
  "gmail-unauthenticated-hme-original-sender",
  "gmail-unauthenticated-hme-relay-auth",
  "gmail-unauthenticated-hme-relay-signature",
  "gmail-timeout",
  "gmail-protocol-error",
] as const satisfies readonly CathayAppVerificationFailureReason[];

const CATHAY_OTP_REASONS: ReadonlySet<string> = new Set(CATHAY_APP_VERIFICATION_FAILURE_REASONS);

const CATHAY_GMAIL_SETTINGS_REASONS: ReadonlySet<CathayAppVerificationFailureReason> = new Set([
  "gmail-disabled",
  "gmail-not-configured",
  "gmail-needs-authorization",
  "gmail-authorization-cancelled",
  "gmail-authorization-failed",
  "gmail-token-invalid",
]);

/** Missing or malformed host metadata must never reveal manual controls. */
export function verificationActorForUiGroup(
  credentialGroupId: string | null | undefined,
  actorsByCredentialGroup: Readonly<Record<string, VerificationActor>> | null | undefined,
): VerificationActor {
  return credentialGroupId && actorsByCredentialGroup?.[credentialGroupId] === "human"
    ? "human"
    : "solver";
}

export function shouldOfferManualVerification(
  credentialGroupId: string | null | undefined,
  actorsByCredentialGroup: Readonly<Record<string, VerificationActor>> | null | undefined,
): boolean {
  return verificationActorForUiGroup(credentialGroupId, actorsByCredentialGroup) === "human";
}

export function onboardingStepForVerificationActor(
  step: OnboardingStep,
  credentialGroupId: string | null | undefined,
  actorsByCredentialGroup: Readonly<Record<string, VerificationActor>> | null | undefined,
): OnboardingStep {
  return step === "assist" && !shouldOfferManualVerification(
    credentialGroupId,
    actorsByCredentialGroup,
  )
    ? "hidden"
    : step;
}

/** Read only the finite, bounded reason codes emitted by the Cathay workflow. */
export function cathayEmailOtpFailureReason(
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[] | null | undefined,
): CathayAppVerificationFailureReason | null {
  const event = latestVerificationFailureEvent(events);
  if (!event?.code.startsWith("cathay-email-otp-")) return null;
  const reason = event.code.slice("cathay-email-otp-".length);
  return CATHAY_OTP_REASONS.has(reason)
    ? reason as CathayAppVerificationFailureReason
    : null;
}

export function verificationSolverExhausted(
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[] | null | undefined,
): boolean {
  return latestVerificationFailureEvent(events)?.code === "verification-solver-exhausted";
}

export function verificationFailureEventReason(
  event: Pick<WorkflowRunEvent, "stage" | "code">,
): CathayAppVerificationFailureReason | "verification-solver-exhausted" | null {
  if (event.stage !== "authentication") return null;
  if (event.code === "verification-solver-exhausted") return event.code;
  if (!event.code.startsWith("cathay-email-otp-")) return null;
  const reason = event.code.slice("cathay-email-otp-".length);
  return CATHAY_OTP_REASONS.has(reason)
    ? reason as CathayAppVerificationFailureReason
    : null;
}

function latestVerificationFailureEvent(
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[] | null | undefined,
) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    if (event?.stage !== "authentication") continue;
    if (event.code === "verification-solver-exhausted"
      || event.code.startsWith("cathay-email-otp-")) return event;
  }
  return null;
}

export function cathayOtpReasonNeedsGmailSettings(
  reason: CathayAppVerificationFailureReason | null | undefined,
): boolean {
  return reason !== null && reason !== undefined
    && CATHAY_GMAIL_SETTINGS_REASONS.has(reason);
}
