import { CaptchaProviderRejectedError } from "./captcha-rejection.ts";
import { ExternalPrerequisiteUnavailableError } from "./external-prerequisite.ts";
import type { WorkflowRunEvent } from "./run-event.ts";
import { BrowserRuntimeConfigurationError } from "./server/browser-runtime.ts";
import { ProviderProtocolOutdatedError, SourceAccessChallengeError, SourceUnavailableError } from "./source-access.ts";
import { SourceTextIntegrityError } from "./source-text.ts";
import { FailureCodeError, TYPED_WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "./workflow-failures.ts";

export type FailureEvidenceEvent = Pick<WorkflowRunEvent, "stage" | "outcome" | "signal">;

/** What one caller can see of a failure. Only the worker holds the thrown error. */
export type FailureEvidence = Readonly<{
  error?: unknown;
  /** The code a worker already named from its thrown error, as the host receives it. */
  reported?: TypedWorkflowErrorCode;
  events: readonly FailureEvidenceEvent[];
  stopped: boolean;
}>;

const ERROR_CODES: ReadonlySet<string> = new Set(TYPED_WORKFLOW_ERROR_CODES);

function thrownCode(error: unknown): TypedWorkflowErrorCode | undefined {
  if (error instanceof FailureCodeError) return ERROR_CODES.has(error.errorCode) ? error.errorCode : undefined;
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";
  if (error instanceof ProviderProtocolOutdatedError) return "provider-protocol-outdated";
  if (error instanceof ExternalPrerequisiteUnavailableError) return "external-prerequisite-unavailable";
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  return undefined;
}

/** The last operation before the run reported its end. */
export function lastOperation<E extends Pick<WorkflowRunEvent, "stage">>(events: readonly E[]): E | undefined {
  return events.findLast((event) => event.stage !== "finalization");
}

/**
 * Failure classification (ADR 0068): the first matching evidence names the
 * Failure code. A stop is named only after a thrown error; whether the stop
 * decides the run stays with the Active Automation Task Run (ADR 0058).
 */
export function classifyFailure({ error, reported, events, stopped }: FailureEvidence): TypedWorkflowErrorCode {
  const signalled = (...signals: readonly NonNullable<FailureEvidenceEvent["signal"]>[]) =>
    events.some((event) => event.signal !== undefined && signals.includes(event.signal));

  // Only the host sees a missing solver route; the worker sees just the rejected request.
  if (signalled("solver-route-unavailable", "solver-challenge-unsupported")) return "verification-configuration-failed";
  const thrown = reported ?? thrownCode(error);
  if (thrown) return thrown;
  if (stopped) return "cancelled";
  if (signalled("verification-solver-exhausted", "human-assistance-failed")) return "verification-failed";
  if (events.some((event) => event.stage === "decoding" && event.outcome === "failed")) return "source-integrity-failed";
  if (events.some((event) => event.stage === "validation" && event.outcome === "failed")) return "source-validation-failed";

  const operation = lastOperation(events);
  if (operation?.stage === "authentication") {
    if (error instanceof Error && error.name === "TimeoutError") return "authentication-timeout";
    if (operation.signal === "login-dialog-interrupted") return "authentication-dialog-interrupted";
    return "authentication-failed";
  }
  if (operation?.stage === "collection" || operation?.stage === "decoding") return "source-collection-failed";
  return "workflow-failed";
}
