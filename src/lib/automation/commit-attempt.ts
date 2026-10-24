import type { RunEventOutcome } from "./run-event.ts";
import { randomUUID } from "node:crypto";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import type { WorkflowFinancialCommitPort } from "./workflow-executor.ts";

/**
 * ADR 0056: one request a run makes to the Canonical Financial Commit
 * capability. The commit port reports it as started before the request and
 * settles it only when the request returns a verifiable result; an attempt that
 * never settles is the run's commit outcome unknown.
 */
export type CommitAttemptOutcome = "completed" | "failed" | "cancelled" | "refused";

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
/** Workflows pass product type ids such as `credit_card` as the attempt's product. */
const PRODUCT = /^[a-z][a-z0-9_-]{0,63}$/u;
const OUTCOMES = new Set<CommitAttemptOutcome>(["completed", "failed", "cancelled", "refused"]);
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
): "commit-outcome-unknown" | "collection-scope-changed" | "canonical-commit-failed" | null {
  if (attempts.some((attempt) => attempt.outcome === null)) return "commit-outcome-unknown";
  if (attempts.some((attempt) => attempt.outcome === "refused")) return "collection-scope-changed";
  if (attempts.some((attempt) => attempt.outcome === "failed")) return "canonical-commit-failed";
  return null;
}

/** Whether financial data may have changed: an item committed, or an attempt never settled. */
export function commitAttemptsMayHaveCommitted(attempts: readonly CommitAttempt[]): boolean {
  return attempts.some((attempt) => attempt.outcome === null || attempt.committedCount > 0);
}

/** Whether the host refused the request's writes before admission (ADR 0058). */
export function commitRefused(result: PGliteWorkflowRunResult<unknown>): boolean {
  return result.items.some((item) => item.status === "failed" && item.failureKind === "refused");
}

/** The request threw or returned a result whose receipts cannot be trusted. */
export class CommitOutcomeUnknownError extends Error {
  readonly errorCode = "commit-outcome-unknown";
  /** Receipts that still answer their own items; the rest of the request is unknown. */
  readonly committedCount: number;

  constructor(committedCount = 0, options?: ErrorOptions) {
    super("Canonical Financial Commit outcome is unknown.", options);
    this.name = "CommitOutcomeUnknownError";
    this.committedCount = committedCount;
  }
}

export type CommitEventCode =
  | "canonical-commit-started"
  | "canonical-commit-completed"
  | "canonical-commit-failed"
  | "canonical-commit-cancelled";

export type RecordedFinancialCommitOptions = Readonly<{
  commit: WorkflowFinancialCommitPort;
  attempts: CommitAttemptRecorder;
  /** Progress only; a failed event never changes the commit outcome. */
  event(
    outcome: RunEventOutcome,
    code: CommitEventCode,
    counts: Readonly<{ completed: number; total: number }>,
    product: string | null,
  ): Promise<void>;
  newAttemptId?: () => string;
}>;

function itemIdentity(item: Pick<PGliteWorkflowRunItem, "provider" | "product" | "itemKey">): string {
  return JSON.stringify([item.provider, item.product, item.itemKey]);
}

/** Committed receipts that answer their own items, or null when any receipt answers another. */
function trustedCommittedCount(
  items: readonly PGliteWorkflowRunItem[],
  result: PGliteWorkflowRunResult<unknown>,
): number | null {
  if (result.items.length > items.length) return null;
  if (result.items.some((item, index) => itemIdentity(item) !== itemIdentity(items[index]!))) return null;
  return result.items.filter((item) => item.status === "committed").length;
}

/** A result is known only when every receipt answers its own item and no item lost its transport. */
function knownOutcome(
  items: readonly PGliteWorkflowRunItem[],
  result: PGliteWorkflowRunResult<unknown>,
  committed: number | null,
): CommitAttemptOutcome | null {
  if (committed === null || result.committedCount !== committed) return null;
  if (result.items.some((item) => item.status === "failed" && item.failureKind === "fatal")) return null;
  if (result.diagnostics.some((diagnostic) => diagnostic.stage === "run")) return null;
  // A refused run stops at its first refused item; the items after it were never sent.
  if (commitRefused(result)) return "refused";
  if (result.status !== "cancelled" && result.items.length !== items.length) return null;
  if (result.status === "completed") return "completed";
  return result.status === "cancelled" ? "cancelled" : "failed";
}

/** A cancelled commit is not a failure; the run status reports the cancellation (ADR 0059). */
const SETTLED_EVENT: Readonly<Record<CommitAttemptOutcome, readonly [RunEventOutcome, CommitEventCode]>> = {
  completed: ["completed", "canonical-commit-completed"],
  failed: ["failed", "canonical-commit-failed"],
  cancelled: ["advanced", "canonical-commit-cancelled"],
  refused: ["failed", "canonical-commit-failed"],
};

/**
 * ADR 0056: the one module that knows a commit happened. It records a started
 * Commit attempt before the request and settles it only from a verifiable
 * result; otherwise it throws CommitOutcomeUnknownError and leaves the attempt
 * unsettled.
 */
export function recordedFinancialCommitPort(
  options: RecordedFinancialCommitOptions,
): WorkflowFinancialCommitPort {
  const newAttemptId = options.newAttemptId ?? randomUUID;
  return {
    async execute(items, executeOptions) {
      // A cancelled run starts no new attempt; one already started still settles.
      executeOptions?.signal?.throwIfAborted();
      const attemptId = newAttemptId();
      const product = executeOptions?.product ?? null;
      const total = items.length;
      await options.attempts.record({ phase: "started", attemptId, product, total });
      await options.event("started", "canonical-commit-started", { completed: 0, total }, product);
      let result: PGliteWorkflowRunResult<unknown>;
      try {
        result = await options.commit.execute(items, executeOptions);
      } catch (error) {
        await options.event("failed", "canonical-commit-failed", { completed: 0, total }, product);
        throw new CommitOutcomeUnknownError(0, { cause: error });
      }
      const committed = trustedCommittedCount(items, result);
      const outcome = knownOutcome(items, result, committed);
      if (outcome === null) {
        await options.event("failed", "canonical-commit-failed", { completed: committed ?? 0, total }, product);
        throw new CommitOutcomeUnknownError(committed ?? 0);
      }
      try {
        await options.attempts.record({
          phase: "settled",
          attemptId,
          outcome,
          committedCount: result.committedCount,
        });
      } catch {
        // A host that received the settlement folds it before persisting it;
        // one that did not reads the attempt as unknown, the safe reading.
      }
      await options.event(...SETTLED_EVENT[outcome], { completed: result.committedCount, total }, product);
      return result;
    },
  };
}
