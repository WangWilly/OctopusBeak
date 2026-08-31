import { randomUUID } from "node:crypto";

/**
 * The Gmail bridge is deliberately separate from the human-assistance
 * contract.  A workflow receives only the result of a host decision; it
 * never receives an OAuth token or mailbox content.
 */
/** @deprecated The bridge now uses the authenticated local IPC endpoint. */
export const GMAIL_OTP_REQUEST_FD_ENV = "OCTOPUSBEAK_GMAIL_OTP_REQUEST_FD";
/** @deprecated The bridge now uses the authenticated local IPC endpoint. */
export const GMAIL_OTP_RESPONSE_FD_ENV = "OCTOPUSBEAK_GMAIL_OTP_RESPONSE_FD";
export const GMAIL_OTP_IPC_ENDPOINT_ENV = "OCTOPUSBEAK_GMAIL_OTP_IPC_ENDPOINT";
export const GMAIL_OTP_IPC_TOKEN_ENV = "OCTOPUSBEAK_GMAIL_OTP_IPC_TOKEN";
export const GMAIL_OTP_MAX_FRAME_BYTES = 8 * 1024;
export const GMAIL_OTP_IPC_TOKEN_BYTES = 32;

const GMAIL_OTP_IPC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type GmailOtpRequest =
  | { id: string; method: "ensure-access" }
  | { id: string; method: "prepare-retrieval" }
  | { id: string; method: "retrieve"; boundaryId: string };

export type GmailOtpResponse =
  | { id: string; status: "ready"; reason?: undefined }
  | { id: string; status: "prepared"; boundaryId: string }
  | { id: string; status: "found"; otp: string }
  | { id: string; status: "fallback"; reason: GmailOtpFallbackReason };

export type GmailOtpIpcAuth = {
  type: "authenticate";
  token: string;
};

export type GmailOtpFallbackReason =
  | "disabled"
  | "not-configured"
  | "needs-authorization"
  | "authorization-cancelled"
  | "authorization-failed"
  | "token-invalid"
  | "gmail-request-failed"
  | "no-candidate"
  | "ambiguous-candidate"
  | "stale-candidate"
  | "malformed-candidate"
  | "unauthenticated-candidate"
  | "unauthenticated-google-results"
  | "unauthenticated-cathay-alignment"
  | "unauthenticated-hme-original-sender"
  | "unauthenticated-hme-relay-auth"
  | "unauthenticated-hme-relay-signature"
  | "timeout"
  | "protocol-error";

const FALLBACK_REASONS = new Set<GmailOtpFallbackReason>([
  "disabled",
  "not-configured",
  "needs-authorization",
  "authorization-cancelled",
  "authorization-failed",
  "token-invalid",
  "gmail-request-failed",
  "no-candidate",
  "ambiguous-candidate",
  "stale-candidate",
  "malformed-candidate",
  "unauthenticated-candidate",
  "unauthenticated-google-results",
  "unauthenticated-cathay-alignment",
  "unauthenticated-hme-original-sender",
  "unauthenticated-hme-relay-auth",
  "unauthenticated-hme-relay-signature",
  "timeout",
  "protocol-error",
]);

/** Return only a bounded, non-secret diagnostic reason from a host outcome. */
export function gmailOtpFallbackReason(value: unknown): GmailOtpFallbackReason | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { kind?: unknown; status?: unknown; reason?: unknown };
  const kind = record.kind ?? record.status;
  return kind === "fallback" &&
    typeof record.reason === "string" &&
    FALLBACK_REASONS.has(record.reason as GmailOtpFallbackReason)
    ? record.reason as GmailOtpFallbackReason
    : null;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{8,64}$/i.test(value);
}

function isSafeOtp(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{4}-[0-9]{6}$/.test(value);
}

export function createGmailOtpRequestId(uuid: () => string = randomUUID) {
  const id = uuid();
  if (!boundedId(id)) throw new Error("Generated Gmail OTP request id is invalid.");
  return id;
}

export function gmailOtpRequestFrame(request: GmailOtpRequest) {
  if (!parseGmailOtpRequest(request)) throw new TypeError("Gmail OTP request is invalid.");
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES)
    throw new RangeError("Gmail OTP request frame is too large.");
  return frame;
}

export function parseGmailOtpRequest(value: unknown): GmailOtpRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (!boundedId(id)) return null;
  if (record.method === "ensure-access" || record.method === "prepare-retrieval")
    return { id, method: record.method };
  if (record.method === "retrieve" && boundedId(record.boundaryId))
    return { id, method: record.method, boundaryId: record.boundaryId };
  return null;
}

export function parseGmailOtpRequestFrame(frame: string): GmailOtpRequest | null {
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) return null;
  try {
    return parseGmailOtpRequest(JSON.parse(frame));
  } catch {
    return null;
  }
}

export function gmailOtpResponseFrame(response: GmailOtpResponse) {
  if (!boundedId(response.id)) throw new TypeError("Gmail OTP response id is invalid.");
  if (response.status === "prepared" && !boundedId(response.boundaryId))
    throw new TypeError("Gmail OTP response boundary id is invalid.");
  if (response.status === "found" && !isSafeOtp(response.otp))
    throw new TypeError("Gmail OTP response answer is invalid.");
  if (response.status === "fallback" && !FALLBACK_REASONS.has(response.reason))
    throw new TypeError("Gmail OTP fallback reason is invalid.");
  const frame = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES)
    throw new RangeError("Gmail OTP response frame is too large.");
  return frame;
}

export function parseGmailOtpResponse(value: unknown): GmailOtpResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (!boundedId(id)) return null;
  const otp = record.otp;
  if (record.status === "ready") return { id, status: "ready" };
  if (record.status === "prepared" && boundedId(record.boundaryId))
    return { id, status: "prepared", boundaryId: record.boundaryId };
  if (record.status === "found" && isSafeOtp(otp)) {
    return { id, status: "found", otp };
  }
  if (
    record.status === "fallback" &&
    typeof record.reason === "string" &&
    FALLBACK_REASONS.has(record.reason as GmailOtpFallbackReason)
  ) {
    return {
      id,
      status: "fallback",
      reason: record.reason as GmailOtpFallbackReason,
    };
  }
  return null;
}

export function parseGmailOtpResponseFrame(frame: string): GmailOtpResponse | null {
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) return null;
  try {
    return parseGmailOtpResponse(JSON.parse(frame));
  } catch {
    return null;
  }
}

export function isGmailOtpIpcToken(value: unknown): value is string {
  return typeof value === "string" && GMAIL_OTP_IPC_TOKEN_PATTERN.test(value);
}

/**
 * The first line on a Gmail IPC connection is an authenticated handshake.
 * It is deliberately separate from request/response frames so the token can
 * never be mistaken for a workflow value.
 */
export function gmailOtpIpcAuthFrame(token: string) {
  if (!isGmailOtpIpcToken(token)) throw new TypeError("Gmail OTP IPC token is invalid.");
  const frame = `${JSON.stringify({ type: "authenticate", token })}\n`;
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES)
    throw new RangeError("Gmail OTP IPC authentication frame is too large.");
  return frame;
}

export function parseGmailOtpIpcAuthFrame(frame: string): GmailOtpIpcAuth | null {
  if (Buffer.byteLength(frame, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) return null;
  try {
    const value = JSON.parse(frame) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.type === "authenticate" && isGmailOtpIpcToken(record.token)
      ? { type: "authenticate", token: record.token }
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse newline-delimited frames without allowing an incomplete line to grow
 * without bound. A single oversized line is rejected even when the transport
 * delivers it together with otherwise valid lines.
 */
export function createGmailOtpLineParser(onLine: (line: string) => void) {
  let pending = "";
  let invalidBytes = 0;
  const decoder = new TextDecoder();
  const push = (chunk: string | Uint8Array) => {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) {
        invalidBytes += 1;
      } else {
        onLine(line);
      }
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) {
      pending = "";
      invalidBytes += 1;
    }
  };
  const flush = () => {
    if (pending.trim()) {
      if (Buffer.byteLength(pending, "utf8") > GMAIL_OTP_MAX_FRAME_BYTES) {
        invalidBytes += 1;
      } else {
        onLine(pending.trim());
      }
    }
    pending = "";
  };
  return {
    push,
    flush,
    invalidFrameCount() {
      return invalidBytes;
    },
  };
}

export function createGmailOtpFrameParser(
  onFrame: (value: GmailOtpRequest | GmailOtpResponse) => void,
  parse: (frame: string) => GmailOtpRequest | GmailOtpResponse | null,
) {
  let invalidFrames = 0;
  const lines = createGmailOtpLineParser((line) => {
    const value = parse(line);
    if (value) onFrame(value);
    else invalidFrames += 1;
  });
  return {
    push: lines.push,
    flush() {
      lines.flush();
    },
    invalidFrameCount() {
      return lines.invalidFrameCount() + invalidFrames;
    },
  };
}
