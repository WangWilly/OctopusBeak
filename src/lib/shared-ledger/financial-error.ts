/**
 * Stable, non-sensitive error codes for financial renderer boundaries.
 *
 * Error objects are intentionally inspected only to classify them.  Callers
 * must use the returned code for UI and diagnostics; the original value must
 * never cross a renderer or logging boundary.
 */
export type FinancialErrorCode =
  | "financial-section-knowledge-point-mismatch"
  | "canonical-cutoff-unavailable"
  | "spending-pair-stale"
  | "spending-action-stale"
  | "idempotency-key-conflict"
  | "idempotency-storage-unavailable"
  | "worker-closed"
  | "worker-exit"
  | "worker-error"
  | "contention"
  | "cancelled"
  | "validation-failed"
  | "unknown";

const EXACT_CODES = new Set<FinancialErrorCode>([
  "financial-section-knowledge-point-mismatch",
  "canonical-cutoff-unavailable",
  "spending-pair-stale",
  "spending-action-stale",
  "idempotency-key-conflict",
  "idempotency-storage-unavailable",
  "worker-closed",
  "worker-exit",
  "worker-error",
  "contention",
  "cancelled",
  "validation-failed",
  "unknown",
]);

function candidateCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}

/** Classify an error without returning any source message or error payload. */
export function stableFinancialErrorCode(error: unknown): FinancialErrorCode {
  const candidate = candidateCode(error);
  if (!candidate) return "unknown";
  if (EXACT_CODES.has(candidate as FinancialErrorCode)) {
    return candidate as FinancialErrorCode;
  }
  if (/busy|locked|contention/i.test(candidate)) return "contention";
  if (/worker.*closed|closed.*worker/i.test(candidate)) return "worker-closed";
  if (/worker.*exit|exit.*worker/i.test(candidate)) return "worker-exit";
  if (/worker/i.test(candidate)) return "worker-error";
  if (/cancel/i.test(candidate)) return "cancelled";
  if (/cutoff/i.test(candidate)) return "canonical-cutoff-unavailable";
  if (/validation|invalid|stale/i.test(candidate)) return "validation-failed";
  return "unknown";
}
