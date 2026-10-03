import type { GmailOtpFallbackReason } from "./gmail-otp.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";

export type CathayAppVerificationFailureReason =
  | (GmailOtpFallbackReason extends infer Reason
      ? Reason extends `gmail-${string}`
        ? Reason
        : `gmail-${Reason & string}`
      : never)
  | "challenge-unavailable"
  | "answer-entry-failed"
  | "send-uncertain"
  | "submission-uncertain"
  | "completion-unconfirmed";

export type CathayAppVerificationErrorCode = Extract<
  TypedWorkflowErrorCode,
  "verification-configuration-failed" | "verification-failed"
>;

const CONFIGURATION_FAILURES = new Set<CathayAppVerificationFailureReason>([
  "challenge-unavailable",
  "gmail-disabled",
  "gmail-not-configured",
  "gmail-needs-authorization",
  "gmail-authorization-cancelled",
  "gmail-authorization-failed",
  "gmail-token-invalid",
]);

export class CathayAppVerificationError extends Error {
  readonly errorCode: CathayAppVerificationErrorCode;
  readonly reason: CathayAppVerificationFailureReason;

  constructor(reason: CathayAppVerificationFailureReason) {
    super("Cathay Email OTP verification could not be completed.");
    this.name = "CathayAppVerificationError";
    this.reason = reason;
    this.errorCode = CONFIGURATION_FAILURES.has(reason)
      ? "verification-configuration-failed"
      : "verification-failed";
  }
}
