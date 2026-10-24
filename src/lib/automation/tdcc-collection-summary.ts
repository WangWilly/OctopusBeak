import type { TdccInvestmentExclusion } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { TdccSettlementExclusion } from "../../ledger/canonical/tdcc-settlement-admission.ts";
import type { TdccProductCollection } from "../../workflows/tdcc-epassbook-collection.ts";
import type { CollectionProductOutcome, ProductCollectionRunSummary } from "./product-collection.ts";
import { productRunStatus } from "./product-run-status.ts";

export const TDCC_PRODUCT_IDS = ["securities", "fund", "settlement"] as const;
export type TdccProductId = typeof TDCC_PRODUCT_IDS[number];

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
    super("TDCC collection evidence violated its run or count invariant.");
    this.name = "TdccCollectionSummaryInvariantError";
  }
}

/** Reduce validated exclusions immediately; never retain their account identifiers. */
function countTdccExclusions(
  exclusions: readonly TdccValidatedExclusion[],
): TdccExclusionCountPatch {
  const counts: Partial<Record<TdccExclusionCountName, number>> = {};
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
        break;
      case "non-iso-currency":
        add("excludedNonIsoCurrencyCount");
        break;
      case "non-numeric-account-number":
        add("excludedNonNumericAccountCount");
        break;
      case "time-deposits-not-admitted":
        add("excludedTimeDepositCount", exclusion.count);
        break;
      case "hidden-account":
        add("hiddenAccountCount");
        break;
      case "bank-not-updated":
        add("excludedBankNotUpdatedCount");
        break;
      case "empty-non-iso-currency":
        add("excludedEmptyNonIsoCurrencyCount");
        break;
    }
  }

  return Object.freeze(counts);
}

function mergeTdccExclusionCounts(
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

function completenessFromCounts(counts: TdccExclusionCountPatch): TdccCollectionCompleteness {
  const positive = TDCC_EXCLUSION_COUNT_NAMES.filter((name) => (counts[name] ?? 0) > 0);
  if (positive.some((name) => name !== "hiddenAccountCount" && name !== "excludedTimeDepositCount")) return "incomplete";
  return positive.length > 0 ? "complete_with_exclusions" : "complete";
}

/** Validate TDCC meaning after the caller has validated the product envelope. */
export function sanitizeTdccProductEvidence(
  typeId: string,
  productStatus: string,
  itemCount: number,
  value: unknown,
): TdccProductCollectionEvidence | null {
  if (!(TDCC_PRODUCT_IDS as readonly string[]).includes(typeId)
    || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).some((key) => !["status", "exclusionCounts"].includes(key))
    || !["complete", "complete_with_exclusions", "incomplete"].includes(String(evidence.status))
    || !evidence.exclusionCounts || typeof evidence.exclusionCounts !== "object" || Array.isArray(evidence.exclusionCounts)) return null;
  const sourceCounts = evidence.exclusionCounts as Record<string, unknown>;
  if (Object.keys(sourceCounts).some((key) => !(TDCC_EXCLUSION_COUNT_NAMES as readonly string[]).includes(key))) return null;
  const counts: Partial<Record<TdccExclusionCountName, number>> = {};
  for (const [name, count] of Object.entries(sourceCounts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > TDCC_MAX_SUMMARY_COUNT) return null;
    if (count > 0) counts[name as TdccExclusionCountName] = count;
  }
  const status = evidence.status as TdccCollectionCompleteness;
  // Incomplete also covers a collector interrupted before it observed exclusions.
  if ((status !== "incomplete" && status !== completenessFromCounts(counts))
    || ((productStatus === "no_data" || productStatus === "not_held") && status !== "complete")
    || (productStatus === "success" && itemCount === 0 && status !== "complete_with_exclusions")) return null;
  return Object.freeze({ status, exclusionCounts: Object.freeze(counts) });
}

export type TdccCollectionDecision = Readonly<{
  kind: "items" | "complete-with-exclusions" | "incomplete" | "absent";
  collection: TdccProductCollection;
}>;

export type RecordValidatedTdccExclusions = (exclusions: readonly TdccValidatedExclusion[]) => void;

/**
 * Each instance belongs to one serial run and retains only bounded evidence.
 * collect scopes the recorder to the callback and marks completion only on return.
 * summarize is repeatable after a callback settles; receipts remain caller-validated.
 * Cancellation and unknown commits keep their original error outside this module.
 */
export function createTdccRunSummary(selectedIds: readonly TdccProductId[]) {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length || selectedIds.some((id) => !TDCC_PRODUCT_IDS.includes(id))) {
    throw new TdccCollectionSummaryInvariantError();
  }
  const observations = new Map<TdccProductId, TdccProductCollectionEvidence>();
  const attempted = new Set<TdccProductId>();
  const completed = new Set<TdccProductId>();
  let active = false;
  return Object.freeze({
    async collect(
      typeId: TdccProductId,
      operation: (record: RecordValidatedTdccExclusions) => Promise<TdccProductCollection>,
    ): Promise<TdccCollectionDecision> {
      if (active || !selected.has(typeId) || attempted.has(typeId)) throw new TdccCollectionSummaryInvariantError();
      attempted.add(typeId);
      active = true;
      let recording = true;
      const record: RecordValidatedTdccExclusions = (exclusions) => {
        if (!recording) throw new TdccCollectionSummaryInvariantError();
        const counts = mergeTdccExclusionCounts(observations.get(typeId)?.exclusionCounts ?? {}, countTdccExclusions(exclusions));
        // Validate the whole run before replacing any evidence, so overflow is atomic.
        aggregateTdccExclusionCounts([
          ...[...observations].filter(([id]) => id !== typeId).map(([, value]) => value.exclusionCounts),
          counts,
        ]);
        observations.set(typeId, Object.freeze({ status: completenessFromCounts(counts), exclusionCounts: counts }));
      };
      try {
        const collection = await operation(record);
        completed.add(typeId);
        const status = observations.get(typeId)?.status ?? "complete";
        const kind = collection.items.length > 0 ? "items"
          : status === "complete_with_exclusions" ? "complete-with-exclusions"
          : status === "incomplete" ? "incomplete"
          : collection.absence === "not_held" ? "absent"
          : "incomplete";
        if (kind === "incomplete" && status !== "incomplete") {
          observations.set(typeId, Object.freeze({ status: "incomplete", exclusionCounts: observations.get(typeId)?.exclusionCounts ?? Object.freeze({}) }));
        }
        return Object.freeze({ kind, collection });
      } finally {
        recording = false;
        active = false;
      }
    },
    summarize(base: ProductCollectionRunSummary): ProductCollectionRunSummary {
      if (active) throw new TdccCollectionSummaryInvariantError();
      const products = base.products.map((product) => {
        if (product.skipReason) return Object.freeze({ ...product });
        const typeId = product.typeId as TdccProductId;
        if (!selected.has(typeId)) throw new TdccCollectionSummaryInvariantError();
        const observed = observations.get(typeId);
        return Object.freeze({
          ...product,
          collection: Object.freeze({
            status: observed?.status === "incomplete" || !completed.has(typeId)
              ? "incomplete" as const : observed?.status ?? "complete" as const,
            exclusionCounts: observed?.exclusionCounts ?? Object.freeze({}),
          }),
        });
      });
      return Object.freeze({
        ...base,
        products: Object.freeze(products),
        status: productRunStatus(products, base.committedCount),
      });
    },
  });
}

type TdccSummaryCounts = Readonly<Partial<Record<TdccExclusionCountName | "committedCount" | "itemCount", number>>>;
type TdccSummaryEvidence = Readonly<{
  counts: TdccSummaryCounts;
  products?: readonly CollectionProductOutcome[];
}>;

/** A TDCC collection gap with known durable receipts remains a partial run. */
export function tdccIncompleteCollectionHasDurableReceipts(
  summary: TdccSummaryEvidence | null | undefined,
  errorCode?: string | null,
): boolean {
  if (!summary || errorCode === "commit-outcome-unknown") return false;
  const productReceipts = summary.products?.reduce((total, product) => total + product.committedCount, 0);
  if (summary.products?.some((product) => product.collection !== undefined)
    && productReceipts !== undefined
    && (!Number.isSafeInteger(productReceipts)
      || productReceipts > TDCC_MAX_SUMMARY_COUNT
      || (summary.counts.committedCount !== undefined && summary.counts.committedCount !== productReceipts))) return false;
  const receipts = summary.counts.committedCount ?? productReceipts ?? 0;
  return receipts > 0 && summary.products?.some((product) => product.collection?.status === "incomplete") === true;
}

/** Both wire ingress paths apply the same TDCC count and result policy. */
export function tdccSummaryMatchesEvidence(summary: TdccSummaryEvidence & { status?: string }): boolean {
  return tdccEvidenceMatchesCounts(summary.products, summary.counts)
    && tdccStatusMatchesEvidence(summary.status, summary.products);
}

function tdccEvidenceMatchesCounts(
  products: readonly CollectionProductOutcome[] | undefined,
  counts: TdccSummaryCounts,
): boolean {
  const evidence = products?.flatMap((product) => product.collection ? [product.collection.exclusionCounts] : []) ?? [];
  if (evidence.length === 0) return true;
  let aggregate: ReturnType<typeof aggregateTdccExclusionCounts>;
  try {
    aggregate = aggregateTdccExclusionCounts(evidence);
  } catch {
    return false;
  }
  if (!TDCC_EXCLUSION_COUNT_NAMES.every((name) => (counts[name] ?? 0) === aggregate[name])) return false;
  if (products) {
    const committedCount = products.reduce((total, product) => total + product.committedCount, 0);
    const itemCount = products.reduce((total, product) => total + product.itemCount, 0);
    if (!Number.isSafeInteger(committedCount) || committedCount > TDCC_MAX_SUMMARY_COUNT
      || !Number.isSafeInteger(itemCount) || itemCount > TDCC_MAX_SUMMARY_COUNT
      || (counts.committedCount !== undefined && counts.committedCount !== committedCount)
      || (counts.itemCount !== undefined && counts.itemCount !== itemCount)) return false;
  }
  return true;
}

/** Keep TDCC's top-level result label truthful when product evidence is present. */
function tdccStatusMatchesEvidence(
  status: string | undefined,
  products: readonly CollectionProductOutcome[] | undefined,
): boolean {
  const evidencedProducts = products?.filter((product) => product.collection !== undefined) ?? [];
  if (evidencedProducts.length === 0) return true;
  if (status === undefined) return false;

  const receipts = products!.reduce((total, product) => total + product.committedCount, 0);
  const hasIncompleteCollection = evidencedProducts.some((product) => product.collection!.status === "incomplete");
  const hasIntentionalExclusions = evidencedProducts.some((product) =>
    product.collection!.status === "complete_with_exclusions");
  const hasExplicitAbsence = products!.some((product) => product.status === "no_data" || product.status === "not_held");
  const hasFailedProduct = products!.some((product) => product.status === "failed");
  const hasAnyExclusions = evidencedProducts.some((product) =>
    Object.values(product.collection!.exclusionCounts).some((count) => count > 0));

  switch (status) {
    case "financial-admitted":
      return receipts > 0 && !hasIncompleteCollection && !hasFailedProduct;
    case "no-data":
      return receipts === 0 && hasExplicitAbsence && !hasIncompleteCollection
        && !hasIntentionalExclusions && !hasAnyExclusions && !hasFailedProduct;
    case "completed":
      // A late cooperative cancellation can preserve a complete collection
      // snapshot as "completed" even when it had receipts or explicit absence.
      return !hasIncompleteCollection && !hasFailedProduct;
    case "partial":
      // A commit may fail after collection completed, so partial does not
      // require an incomplete-collection marker. It always requires receipts.
      return receipts > 0;
    case "failed":
      return receipts === 0;
    case "source-only":
    default:
      return false;
  }
}
