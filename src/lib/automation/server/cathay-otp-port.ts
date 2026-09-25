import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import { gmailOtpFallbackReason, type GmailOtpFallbackReason } from "../gmail-otp.ts";
import {
  CATHAY_GMAIL_POLL_TIMEOUT_MS,
  ensureCathayGmailOtpAccess,
  prepareCathayGmailOtpRetrieval,
  retrieveCathayGmailOtp,
} from "./gmail-otp-service.ts";

/** Existing App-owned service operations. No mailbox payload or OAuth data enters this adapter. */
export type CathayGmailOtpHostOperations = Readonly<{
  ensureAccess: typeof ensureCathayGmailOtpAccess;
  prepareRetrieval: typeof prepareCathayGmailOtpRetrieval;
  retrieve: typeof retrieveCathayGmailOtp;
}>;

const hostOperations: CathayGmailOtpHostOperations = {
  ensureAccess: ensureCathayGmailOtpAccess,
  prepareRetrieval: prepareCathayGmailOtpRetrieval,
  retrieve: retrieveCathayGmailOtp,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OTP_PATTERN = /^[A-Z]{4}-[0-9]{6}$/u;
const DEFAULT_BOUNDARY_LIMIT = 128;
const SERVICE_BOUNDARY_TTL_MS = CATHAY_GMAIL_POLL_TIMEOUT_MS + 60_000;

function fallback(reason: GmailOtpFallbackReason) {
  return { status: "fallback" as const, reason };
}

function awaitCathayOtpHostOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new Error("Cathay OTP host operation was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Cathay OTP host operation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function boundedFallback(
  value: unknown,
  defaultReason: GmailOtpFallbackReason,
) {
  return fallback(gmailOtpFallbackReason(value) ?? defaultReason);
}

/**
 * Adapt the host Gmail OTP service to Cathay's result-only provider port.
 * The provider owns the one-shot email-send action; this adapter makes each
 * prepared retrieval boundary one-shot as well and exposes only bounded
 * statuses, reason codes, and a validated OTP.
 */
export function createCathayGmailOtpPort(
  operations: CathayGmailOtpHostOperations = hostOperations,
  options: Readonly<{
    now?: () => number;
    maxPendingBoundaries?: number;
    signal?: AbortSignal;
  }> = {},
): CathayGmailOtpPort {
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const maxPendingBoundaries = options.maxPendingBoundaries ?? DEFAULT_BOUNDARY_LIMIT;
  const pendingBoundaries = new Map<string, number>();

  const pruneExpiredBoundaries = (at: number) => {
    for (const [boundaryId, createdAt] of pendingBoundaries) {
      if (at - createdAt > SERVICE_BOUNDARY_TTL_MS) {
        pendingBoundaries.delete(boundaryId);
      }
    }
  };

  return {
    async ensureAccess() {
      if (signal?.aborted) return fallback("gmail-request-failed");
      try {
        const result: unknown = await awaitCathayOtpHostOperation(operations.ensureAccess(signal), signal);
        if (signal?.aborted) return fallback("gmail-request-failed");
        if (
          result && typeof result === "object" &&
          (result as { status?: unknown }).status === "ready"
        ) return { status: "ready" };
        return boundedFallback(result, "authorization-failed");
      } catch {
        return fallback(signal?.aborted ? "gmail-request-failed" : "authorization-failed");
      }
    },

    async prepareRetrieval() {
      if (signal?.aborted) return fallback("gmail-request-failed");
      try {
        const result: unknown = await awaitCathayOtpHostOperation(operations.prepareRetrieval(signal), signal);
        if (signal?.aborted) return fallback("gmail-request-failed");
        const record = result && typeof result === "object"
          ? result as { status?: unknown; boundaryId?: unknown }
          : null;
        if (
          record?.status !== "prepared" ||
          typeof record.boundaryId !== "string" ||
          !UUID_PATTERN.test(record.boundaryId)
        ) return boundedFallback(result, "protocol-error");

        const at = now();
        pruneExpiredBoundaries(at);
        if (
          pendingBoundaries.has(record.boundaryId) ||
          pendingBoundaries.size >= maxPendingBoundaries
        ) return fallback("protocol-error");
        pendingBoundaries.set(record.boundaryId, at);
        return { status: "prepared", boundaryId: record.boundaryId };
      } catch {
        return fallback("gmail-request-failed");
      }
    },

    async retrieve(boundaryId) {
      const at = now();
      pruneExpiredBoundaries(at);
      const createdAt = pendingBoundaries.get(boundaryId);
      if (createdAt === undefined) return fallback("protocol-error");
      // Consume before calling the service so a rejection or cancellation cannot
      // cause a caller retry to inspect the same one-shot Gmail boundary.
      pendingBoundaries.delete(boundaryId);
      if (at - createdAt > SERVICE_BOUNDARY_TTL_MS) {
        return fallback("protocol-error");
      }
      if (signal?.aborted) return fallback("gmail-request-failed");

      try {
        const result: unknown = await awaitCathayOtpHostOperation(operations.retrieve(boundaryId, signal), signal);
        if (signal?.aborted) return fallback("gmail-request-failed");
        const record = result && typeof result === "object"
          ? result as { status?: unknown; otp?: unknown }
          : null;
        if (
          record?.status === "found" &&
          typeof record.otp === "string" &&
          OTP_PATTERN.test(record.otp)
        ) return { status: "found", otp: record.otp };
        if (record?.status === "found") return fallback("malformed-candidate");
        return boundedFallback(result, "protocol-error");
      } catch {
        return fallback("gmail-request-failed");
      }
    },
  };
}
