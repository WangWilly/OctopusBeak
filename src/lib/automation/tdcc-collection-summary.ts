import type { TdccInvestmentExclusion } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { TdccSettlementExclusion } from "../../ledger/canonical/tdcc-settlement-admission.ts";

export const TDCC_EXCLUSION_COUNT_NAMES = [
  "excludedUnknownInstitutionCount",
  "excludedNonIsoCurrencyCount",
  "excludedNonNumericAccountCount",
  "excludedTimeDepositCount",
  "hiddenAccountCount",
  "excludedBankNotUpdatedCount",
  "excludedEmptyNonIsoCurrencyCount",
] as const;
export const TDCC_MAX_SUMMARY_COUNT = 1_000_000_000;

export type TdccExclusionCountName = typeof TDCC_EXCLUSION_COUNT_NAMES[number];
export type TdccExclusionCounts = Readonly<Record<TdccExclusionCountName, number>>;
export type TdccExclusionCountPatch = Readonly<Partial<Record<TdccExclusionCountName, number>>>;
export type TdccCollectionCompleteness = "complete" | "complete_with_exclusions" | "incomplete";
export type TdccValidatedExclusion = TdccSettlementExclusion | TdccInvestmentExclusion;

export type TdccProductCollectionEvidence = Readonly<{
  status: TdccCollectionCompleteness;
  exclusionCounts: TdccExclusionCountPatch;
}>;

export class TdccCollectionSummaryInvariantError extends Error {
  constructor() {
    super("TDCC exclusion summary counts exceeded the supported bound.");
    this.name = "TdccCollectionSummaryInvariantError";
  }
}

/** Convert a validated provider exclusion into bounded counts and completeness evidence. */
export function summarizeTdccExclusions(
  exclusions: readonly TdccValidatedExclusion[],
): TdccProductCollectionEvidence {
  const counts: Partial<Record<TdccExclusionCountName, number>> = {};
  let incomplete = false;
  const add = (name: TdccExclusionCountName, amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > TDCC_MAX_SUMMARY_COUNT) {
      throw new TdccCollectionSummaryInvariantError();
    }
    if (amount === 0) return;
    const next = (counts[name] ?? 0) + amount;
    if (!Number.isSafeInteger(next) || next > TDCC_MAX_SUMMARY_COUNT) {
      throw new TdccCollectionSummaryInvariantError();
    }
    counts[name] = next;
  };

  for (const exclusion of exclusions) {
    switch (exclusion.reason) {
      case "unknown-institution-code":
        add("excludedUnknownInstitutionCount");
        incomplete = true;
        break;
      case "non-iso-currency":
        add("excludedNonIsoCurrencyCount");
        incomplete = true;
        break;
      case "non-numeric-account-number":
        add("excludedNonNumericAccountCount");
        incomplete = true;
        break;
      case "time-deposits-not-admitted":
        add("excludedTimeDepositCount", exclusion.count);
        break;
      case "hidden-account":
        add("hiddenAccountCount");
        break;
      case "bank-not-updated":
        add("excludedBankNotUpdatedCount");
        incomplete = true;
        break;
      case "empty-non-iso-currency":
        add("excludedEmptyNonIsoCurrencyCount");
        incomplete = true;
        break;
    }
  }

  const hasExclusions = Object.values(counts).some((count) => count !== undefined && count > 0);
  return Object.freeze({
    status: incomplete ? "incomplete" : hasExclusions ? "complete_with_exclusions" : "complete",
    exclusionCounts: Object.freeze(counts),
  });
}

export function mergeTdccExclusionCounts(
  left: TdccExclusionCountPatch,
  right: TdccExclusionCountPatch,
): TdccExclusionCountPatch {
  const merged: Partial<Record<TdccExclusionCountName, number>> = {};
  for (const name of TDCC_EXCLUSION_COUNT_NAMES) {
    const value = (left[name] ?? 0) + (right[name] ?? 0);
    if (!Number.isSafeInteger(value) || value > TDCC_MAX_SUMMARY_COUNT) throw new TdccCollectionSummaryInvariantError();
    if (value > 0) merged[name] = value;
  }
  return Object.freeze(merged);
}

export function aggregateTdccExclusionCounts(
  values: readonly TdccExclusionCountPatch[],
): TdccExclusionCounts {
  const totals = Object.create(null) as Record<TdccExclusionCountName, number>;
  for (const name of TDCC_EXCLUSION_COUNT_NAMES) totals[name] = 0;
  for (const value of values) {
    for (const name of TDCC_EXCLUSION_COUNT_NAMES) {
      const next = totals[name] + (value[name] ?? 0);
      if (!Number.isSafeInteger(next) || next > TDCC_MAX_SUMMARY_COUNT) throw new TdccCollectionSummaryInvariantError();
      totals[name] = next;
    }
  }
  return Object.freeze(totals);
}

export function tdccCompletenessAfterMerge(
  left: TdccCollectionCompleteness,
  right: TdccCollectionCompleteness,
): TdccCollectionCompleteness {
  if (left === "incomplete" || right === "incomplete") return "incomplete";
  if (left === "complete_with_exclusions" || right === "complete_with_exclusions") return "complete_with_exclusions";
  return "complete";
}
