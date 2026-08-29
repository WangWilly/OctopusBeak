import { randomUUID } from "node:crypto";

/**
 * Private workflow-to-host protocol for one CAPTCHA challenge round.
 *
 * This module deliberately contains only bounded identifiers and outcome
 * classifications. Challenge pixels, solver answers, credentials, and
 * provider response bodies never belong in this protocol.
 */
export const CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION = 1 as const;
export const CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES = 8 * 1024;
export const CAPTCHA_ROUND_OUTCOME_IPC_TOKEN_BYTES = 32;
export const CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV =
  "OCTOPUSBEAK_CAPTCHA_ROUND_OUTCOME_ENDPOINT";
export const CAPTCHA_ROUND_OUTCOME_TOKEN_ENV =
  "OCTOPUSBEAK_CAPTCHA_ROUND_OUTCOME_TOKEN";
export const CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV =
  "OCTOPUSBEAK_CAPTCHA_ROUND_OUTCOME_EXECUTION_ID";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POSITIVE_SEQUENCE_MAX = 0x7fffffff;

export type CaptchaRoundChallengeKind = "text-captcha" | "image-selection";

export type CaptchaRoundFailureReason =
  | "capture-failed"
  | "invalid-captured-challenge"
  | "solver-error"
  | "infrastructure-failed"
  | "ambiguous-provider-result"
  | "unsupported-challenge";

export type CaptchaRoundCancellationReason =
  | "user-cancelled"
  | "process-interrupted"
  | "provider-aborted";

export type CaptchaProviderRejectionProof = {
  providerId: string;
  probeId: string;
};

export type CaptchaRoundOutcome =
  | {
      kind: "captured";
      stageId: string;
      challengeKind: CaptchaRoundChallengeKind;
    }
  | {
      kind: "succeeded";
      stageId: string;
    }
  | {
      kind: "retryable";
      stageId: string;
      reason: "solver-exhausted";
    }
  | ({
      kind: "retryable";
      stageId: string;
      reason: "provider-rejected";
    } & CaptchaProviderRejectionProof)
  | {
      kind: "failed";
      stageId: string;
      reason: CaptchaRoundFailureReason;
    }
  | {
      kind: "cancelled";
      stageId: string;
      reason: CaptchaRoundCancellationReason;
    };

export type CaptchaRoundOutcomeMessage = {
  schemaVersion: typeof CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION;
  type: "captcha-round-outcome";
  executionId: string;
  sequence: number;
  outcome: CaptchaRoundOutcome;
};

export type CaptchaRoundOutcomeIpcAuth = {
  schemaVersion: typeof CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION;
  type: "authenticate";
  executionId: string;
  token: string;
};

export type CaptchaRoundOutcomeRejectionReason =
  | "malformed-message"
  | "wrong-execution"
  | "duplicate-sequence"
  | "stale-sequence"
  | "out-of-order-sequence"
  | "capture-already-reported"
  | "terminal-outcome-before-capture"
  | "terminal-outcome-already-reported"
  | "stage-mismatch";

export type CaptchaRoundOutcomeAcceptance =
  | { accepted: true }
  | { accepted: false; reason: CaptchaRoundOutcomeRejectionReason };

export type CaptchaRoundOutcomeReceiverState = {
  executionId: string;
  lastSequence: number;
  challengeCaptured: boolean;
  terminal: boolean;
  capturedStageId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= POSITIVE_SEQUENCE_MAX;
}

function isChallengeKind(value: unknown): value is CaptchaRoundChallengeKind {
  return value === "text-captcha" || value === "image-selection";
}

function isFailureReason(value: unknown): value is CaptchaRoundFailureReason {
  return value === "capture-failed"
    || value === "invalid-captured-challenge"
    || value === "solver-error"
    || value === "infrastructure-failed"
    || value === "ambiguous-provider-result"
    || value === "unsupported-challenge";
}

function isCancellationReason(
  value: unknown,
): value is CaptchaRoundCancellationReason {
  return value === "user-cancelled"
    || value === "process-interrupted"
    || value === "provider-aborted";
}

export function isCaptchaRoundOutcomeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function createCaptchaRoundOutcomeExecutionId(
  uuid: () => string = randomUUID,
) {
  const id = uuid();
  if (!isIdentifier(id)) {
    throw new Error("Generated CAPTCHA round outcome execution ID is invalid.");
  }
  return id;
}

export function isCaptchaRoundOutcome(value: unknown): value is CaptchaRoundOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (!isIdentifier(value.stageId)) return false;

  switch (value.kind) {
    case "captured":
      return exactKeys(value, ["kind", "stageId", "challengeKind"])
        && isChallengeKind(value.challengeKind);
    case "succeeded":
      return exactKeys(value, ["kind", "stageId"]);
    case "retryable":
      if (value.reason === "solver-exhausted") {
        return exactKeys(value, ["kind", "stageId", "reason"]);
      }
      return value.reason === "provider-rejected"
        && exactKeys(value, ["kind", "stageId", "reason", "providerId", "probeId"])
        && isIdentifier(value.providerId)
        && isIdentifier(value.probeId);
    case "failed":
      return exactKeys(value, ["kind", "stageId", "reason"])
        && isFailureReason(value.reason);
    case "cancelled":
      return exactKeys(value, ["kind", "stageId", "reason"])
        && isCancellationReason(value.reason);
    default:
      return false;
  }
}

export function createCaptchaRoundOutcomeMessage(
  executionId: string,
  sequence: number,
  outcome: CaptchaRoundOutcome,
): CaptchaRoundOutcomeMessage {
  const message: CaptchaRoundOutcomeMessage = {
    schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
    type: "captcha-round-outcome",
    executionId,
    sequence,
    outcome,
  };
  if (!parseCaptchaRoundOutcomeMessage(message)) {
    throw new TypeError("CAPTCHA round outcome message is invalid.");
  }
  return message;
}

export function parseCaptchaRoundOutcome(value: unknown): CaptchaRoundOutcome | null {
  return isCaptchaRoundOutcome(value) ? value : null;
}

export function parseCaptchaRoundOutcomeMessage(
  value: unknown,
): CaptchaRoundOutcomeMessage | null {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "type", "executionId", "sequence", "outcome"])
    || value.schemaVersion !== CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION
    || value.type !== "captcha-round-outcome"
    || !isIdentifier(value.executionId)
    || !isPositiveSequence(value.sequence)) {
    return null;
  }
  const outcome = parseCaptchaRoundOutcome(value.outcome);
  return outcome === null
    ? null
    : {
        schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
        type: "captcha-round-outcome",
        executionId: value.executionId,
        sequence: value.sequence,
        outcome,
      };
}

export function captchaRoundOutcomeFrame(
  message: CaptchaRoundOutcomeMessage,
) {
  if (!parseCaptchaRoundOutcomeMessage(message)) {
    throw new TypeError("CAPTCHA round outcome message is invalid.");
  }
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame, "utf8") > CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES) {
    throw new RangeError("CAPTCHA round outcome frame is too large.");
  }
  return frame;
}

export function parseCaptchaRoundOutcomeFrame(
  frame: string,
): CaptchaRoundOutcomeMessage | null {
  if (Buffer.byteLength(frame, "utf8") > CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES) {
    return null;
  }
  try {
    return parseCaptchaRoundOutcomeMessage(JSON.parse(frame));
  } catch {
    return null;
  }
}

export function captchaRoundOutcomeAuthFrame(input: {
  executionId: string;
  token: string;
}) {
  if (!isIdentifier(input.executionId) || !isCaptchaRoundOutcomeToken(input.token)) {
    throw new TypeError("CAPTCHA round outcome authentication is invalid.");
  }
  const auth: CaptchaRoundOutcomeIpcAuth = {
    schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
    type: "authenticate",
    executionId: input.executionId,
    token: input.token,
  };
  const frame = `${JSON.stringify(auth)}\n`;
  if (Buffer.byteLength(frame, "utf8") > CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES) {
    throw new RangeError("CAPTCHA round outcome authentication frame is too large.");
  }
  return frame;
}

export function parseCaptchaRoundOutcomeAuth(
  value: unknown,
): CaptchaRoundOutcomeIpcAuth | null {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "type", "executionId", "token"])
    || value.schemaVersion !== CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION
    || value.type !== "authenticate"
    || !isIdentifier(value.executionId)
    || !isCaptchaRoundOutcomeToken(value.token)) {
    return null;
  }
  return {
    schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
    type: "authenticate",
    executionId: value.executionId,
    token: value.token,
  };
}

export function parseCaptchaRoundOutcomeAuthFrame(
  frame: string,
): CaptchaRoundOutcomeIpcAuth | null {
  if (Buffer.byteLength(frame, "utf8") > CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES) {
    return null;
  }
  try {
    return parseCaptchaRoundOutcomeAuth(JSON.parse(frame));
  } catch {
    return null;
  }
}

function isTerminalOutcome(outcome: CaptchaRoundOutcome) {
  return outcome.kind !== "captured";
}

/**
 * Host-side pure guard for one authenticated execution. It intentionally
 * validates sequence and lifecycle state independently from transport code so
 * a later socket server cannot accidentally accept duplicate or stale events.
 */
export function createCaptchaRoundOutcomeReceiver(executionId: string) {
  if (!isIdentifier(executionId)) {
    throw new TypeError("CAPTCHA round outcome execution ID is invalid.");
  }
  let current: CaptchaRoundOutcomeReceiverState = {
    executionId,
    lastSequence: 0,
    challengeCaptured: false,
    terminal: false,
  };

  const accept = (value: unknown): CaptchaRoundOutcomeAcceptance => {
    const message = parseCaptchaRoundOutcomeMessage(value);
    if (!message) return { accepted: false, reason: "malformed-message" };
    if (message.executionId !== current.executionId) {
      return { accepted: false, reason: "wrong-execution" };
    }
    if (message.sequence === current.lastSequence) {
      return { accepted: false, reason: "duplicate-sequence" };
    }
    if (message.sequence < current.lastSequence) {
      return { accepted: false, reason: "stale-sequence" };
    }
    if (message.sequence !== current.lastSequence + 1) {
      return { accepted: false, reason: "out-of-order-sequence" };
    }
    const outcome = message.outcome;
    if (current.terminal) {
      return { accepted: false, reason: "terminal-outcome-already-reported" };
    }
    if (outcome.kind === "captured") {
      if (current.challengeCaptured) {
        return { accepted: false, reason: "capture-already-reported" };
      }
      current = {
        ...current,
        lastSequence: message.sequence,
        challengeCaptured: true,
        capturedStageId: outcome.stageId,
      };
      return { accepted: true };
    }
    if (isTerminalOutcome(outcome) && outcome.kind !== "failed" && outcome.kind !== "cancelled"
      && !current.challengeCaptured) {
      return { accepted: false, reason: "terminal-outcome-before-capture" };
    }
    if (current.challengeCaptured && outcome.stageId !== current.capturedStageId) {
      return { accepted: false, reason: "stage-mismatch" };
    }
    current = {
      ...current,
      lastSequence: message.sequence,
      terminal: true,
    };
    return { accepted: true };
  };

  return {
    accept,
    acceptFrame(frame: string) {
      const message = parseCaptchaRoundOutcomeFrame(frame);
      return accept(message);
    },
    state(): CaptchaRoundOutcomeReceiverState {
      return { ...current };
    },
  };
}

export function captchaProviderRejectionProbeKey(
  providerId: string,
  probeId: string,
) {
  if (!isIdentifier(providerId) || !isIdentifier(probeId)) {
    throw new TypeError("CAPTCHA provider rejection probe is invalid.");
  }
  return `${providerId}:${probeId}`;
}

export function isRegisteredCaptchaProviderRejectionProof(
  proof: CaptchaProviderRejectionProof,
  registered: ReadonlySet<string> | readonly CaptchaProviderRejectionProof[],
) {
  if (!isCaptchaProviderRejectionProof(proof)) return false;
  const key = captchaProviderRejectionProbeKey(proof.providerId, proof.probeId);
  if ("has" in registered && typeof registered.has === "function") {
    return registered.has(key);
  }
  return (registered as readonly CaptchaProviderRejectionProof[]).some((candidate) =>
    isCaptchaProviderRejectionProof(candidate)
      && captchaProviderRejectionProbeKey(candidate.providerId, candidate.probeId) === key,
  );
}

function isCaptchaProviderRejectionProof(
  value: unknown,
): value is CaptchaProviderRejectionProof {
  return isRecord(value)
    && exactKeys(value, ["providerId", "probeId"])
    && isIdentifier(value.providerId)
    && isIdentifier(value.probeId);
}
