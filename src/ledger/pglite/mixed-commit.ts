import type { PGliteStore } from "./transaction.ts";
import {
  admitPGliteCanonicalSourceCaptureInTransaction,
  assertPGliteCanonicalCommitNotCancelled,
  commitPGliteCanonicalFinancialCaptureInTransaction,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalFinancialCommitRequest,
  type PGliteCanonicalSourceAdmissionRequest,
  type PGliteCanonicalSourceAdmissionReceipt,
  type PGliteCanonicalFinancialCommitResult,
} from "./canonical-source-store.ts";
import {
  commitPGliteCanonicalDepositCaptureInTransaction,
  type PGliteCanonicalDepositCommitRequest,
  type PGliteCanonicalDepositCommitResult,
} from "./deposit.ts";

export const PGLITE_CANONICAL_MIXED_COMMIT_COMMAND = "canonical.mixed.commit" as const;

export type PGliteCanonicalMixedCommitStep =
  | Readonly<{ kind: "source"; request: PGliteCanonicalSourceAdmissionRequest }>
  | Readonly<{ kind: "financial"; request: PGliteCanonicalFinancialCommitRequest }>
  | Readonly<{ kind: "deposit"; request: PGliteCanonicalDepositCommitRequest }>;

export type PGliteCanonicalMixedCommitRequest = Readonly<{
  /** Ordered, data-only actions belonging to one provider item. */
  steps: readonly PGliteCanonicalMixedCommitStep[];
}>;

export type PGliteCanonicalMixedCommitResult = Readonly<{
  admissions: readonly PGliteCanonicalSourceAdmissionReceipt[];
  financial: readonly PGliteCanonicalFinancialCommitResult[];
  deposits: readonly PGliteCanonicalDepositCommitResult[];
}>;

/** Raw evidence and derived facts either become visible together or not at all. */
export async function commitPGliteCanonicalMixedCapture(
  store: PGliteStore,
  request: PGliteCanonicalMixedCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalMixedCommitResult> {
  if (!request || !Array.isArray(request.steps) || request.steps.length === 0)
    throw new TypeError("Mixed financial commit requires at least one step.");
  return store.transaction(async (transaction) => {
    const admissions: PGliteCanonicalSourceAdmissionReceipt[] = [];
    const financial: PGliteCanonicalFinancialCommitResult[] = [];
    const deposits: PGliteCanonicalDepositCommitResult[] = [];
    for (const step of request.steps) {
      assertPGliteCanonicalCommitNotCancelled(options.signal);
      if (step.kind === "source") {
        const admitted = await admitPGliteCanonicalSourceCaptureInTransaction(transaction, step.request, options);
        admissions.push(admitted.receipt);
      } else if (step.kind === "financial") {
        financial.push(await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, step.request, options));
      } else if (step.kind === "deposit") {
        deposits.push(await commitPGliteCanonicalDepositCaptureInTransaction(transaction, step.request, options));
      } else {
        throw new TypeError("Mixed financial commit has an unknown step.");
      }
    }
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return Object.freeze({
      admissions: Object.freeze(admissions),
      financial: Object.freeze(financial),
      deposits: Object.freeze(deposits),
    });
  });
}
