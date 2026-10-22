/**
 * ADR 0056: one request a run makes to the Canonical Financial Commit
 * capability. The commit port reports it as started before the request and
 * settles it only when the request returns a verifiable result; an attempt that
 * never settles is the run's commit outcome unknown.
 */
export type CommitAttemptOutcome = "completed" | "failed" | "cancelled";

export type CommitAttemptReport =
  | Readonly<{ phase: "started"; attemptId: string; product: string | null; total: number }>
  | Readonly<{ phase: "settled"; attemptId: string; outcome: CommitAttemptOutcome; committedCount: number }>;

export type CommitAttempt = Readonly<{
  attemptId: string;
  product: string | null;
  total: number;
  /** Null until the attempt settles: the outcome is unknown. */
  outcome: CommitAttemptOutcome | null;
  committedCount: number;
}>;

/** Records a report durably before the commit port proceeds. */
export interface CommitAttemptRecorder {
  record(report: CommitAttemptReport): Promise<void>;
}

const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PRODUCT = /^[a-z][a-z0-9-]{0,63}$/u;
const OUTCOMES = new Set<CommitAttemptOutcome>(["completed", "failed", "cancelled"]);
const MAX_COUNT = 1_000_000_000;

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isCommitAttemptReport(value: unknown): value is CommitAttemptReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.attemptId !== "string" || !ATTEMPT_ID.test(report.attemptId)) return false;
  if (report.phase === "started") {
    return exactKeys(report, ["phase", "attemptId", "product", "total"])
      && (report.product === null || (typeof report.product === "string" && PRODUCT.test(report.product)))
      && count(report.total);
  }
  return report.phase === "settled"
    && exactKeys(report, ["phase", "attemptId", "outcome", "committedCount"])
    && OUTCOMES.has(report.outcome as CommitAttemptOutcome)
    && count(report.committedCount);
}

/** Fold one report into a run's attempts. A settlement needs its own unsettled start. */
export function applyCommitAttemptReport(
  attempts: readonly CommitAttempt[],
  report: CommitAttemptReport,
): readonly CommitAttempt[] {
  const index = attempts.findIndex((attempt) => attempt.attemptId === report.attemptId);
  if (report.phase === "started") {
    if (index !== -1) throw new Error("Commit attempt already started.");
    return [...attempts, {
      attemptId: report.attemptId,
      product: report.product,
      total: report.total,
      outcome: null,
      committedCount: 0,
    }];
  }
  const attempt = attempts[index];
  if (!attempt || attempt.outcome !== null) throw new Error("Commit attempt is not awaiting settlement.");
  if (report.committedCount > attempt.total) throw new Error("Commit attempt settled more items than it started.");
  return attempts.map((current, position) => position === index
    ? { ...current, outcome: report.outcome, committedCount: report.committedCount }
    : current);
}

/** A run's commit outcome: unknown outranks failure, and otherwise nothing to report. */
export function commitAttemptsErrorCode(
  attempts: readonly CommitAttempt[],
): "commit-outcome-unknown" | "canonical-commit-failed" | null {
  if (attempts.some((attempt) => attempt.outcome === null)) return "commit-outcome-unknown";
  if (attempts.some((attempt) => attempt.outcome === "failed")) return "canonical-commit-failed";
  return null;
}

/** Whether financial data may have changed: an item committed, or an attempt never settled. */
export function commitAttemptsMayHaveCommitted(attempts: readonly CommitAttempt[]): boolean {
  return attempts.some((attempt) => attempt.outcome === null || attempt.committedCount > 0);
}
