import {
  calendarDayDistance,
  calendarDayNumber,
  exactMoneyEqual,
  exactMoneyKey,
  invoiceMatchingMoney,
  transactionPurchaseDate,
  type SpendingMatchingInvoice,
  type SpendingMatchingMoney,
  type SpendingMatchingTransaction,
} from "../../lib/spending/purchase-matching.ts";
import {
  cachedSpendingPairingRank,
  cacheSpendingPairingRank,
  createSpendingPairingIndex,
  type SpendingPairingIndex,
  type SpendingPairingIndexEntry,
} from "./spending-pairing-index.ts";
import { merchantSimilarityTo } from "./spending-match-strength.ts";
import {
  absoluteExact,
  compareExact,
  normalizeCurrency,
  sameCurrency,
  subtractExact,
  type ExactAmount,
} from "../../lib/shared-money/exact-money.ts";

export type { SpendingPairingIndex } from "./spending-pairing-index.ts";

/** The absolute difference of two amounts, reduced. */
function exactMoneyDifference(left: SpendingMatchingMoney, right: SpendingMatchingMoney): ExactAmount {
  return absoluteExact(subtractExact(left, right));
}

const ZERO: ExactAmount = { coefficient: "0", scale: 0 };

export type SpendingManualPaymentCandidate = Readonly<{
  transactionId: string;
  tier: 1 | 2 | 3;
  dateDistanceDays: number;
  amountDifference: Readonly<{ coefficient: string; scale: number; currency: string }> | null;
  merchantSimilarity: number;
}>;

function manualCandidateCacheKey(invoice: SpendingMatchingInvoice): string {
  const amount = invoiceMatchingMoney(invoice);
  return JSON.stringify([
    amount ? exactMoneyKey(amount) : null,
    invoice.revision.occurrence.value,
    invoice.revision.seller.name ?? null,
  ]);
}

function compareManualCandidates(left: SpendingManualPaymentCandidate, right: SpendingManualPaymentCandidate): number {
  if (left.tier !== right.tier) return left.tier - right.tier;
  if (left.dateDistanceDays !== right.dateDistanceDays) return left.dateDistanceDays - right.dateDistanceDays;
  if (left.tier === 2) {
    const amountOrder = compareExact(left.amountDifference ?? ZERO, right.amountDifference ?? ZERO);
    if (amountOrder !== 0) return amountOrder;
  }
  if (left.merchantSimilarity !== right.merchantSimilarity) return right.merchantSimilarity - left.merchantSimilarity;
  return left.transactionId.localeCompare(right.transactionId);
}

function compareDateDistances(left: number, right: number): number {
  if (left === right) return 0;
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return left - right;
}

/**
 * One invoice's candidates in rank order. Candidates are grouped by tier and
 * calendar distance, which order the groups; a group is scored and sorted only
 * when a page or a lookup reaches it, so a dialog page does not sort the whole
 * transaction set.
 */
export type SpendingManualPaymentRanking = Readonly<{
  total: number;
  page(offset: number, limit: number): readonly SpendingManualPaymentCandidate[];
  find(transactionId: string): SpendingManualPaymentCandidate | undefined;
  all(): readonly SpendingManualPaymentCandidate[];
}>;

type RankGroup = {
  tier: 1 | 2 | 3;
  distance: number;
  entries: SpendingPairingIndexEntry[];
  ranked: readonly SpendingManualPaymentCandidate[] | null;
};

const EMPTY_RANKING: SpendingManualPaymentRanking = Object.freeze({
  total: 0,
  page: () => Object.freeze([]),
  find: () => undefined,
  all: () => Object.freeze([]),
});

function rankGroupKey(tier: 1 | 2 | 3, distance: number): string {
  return `${tier}:${Number.isFinite(distance) ? distance : "infinity"}`;
}

export function spendingManualPaymentRanking(
  invoice: SpendingMatchingInvoice,
  index: SpendingPairingIndex,
): SpendingManualPaymentRanking {
  const invoiceAmount = invoiceMatchingMoney(invoice);
  if (!invoiceAmount) return EMPTY_RANKING;
  const cacheKey = manualCandidateCacheKey(invoice);
  const cached = cachedSpendingPairingRank(index, cacheKey);
  if (cached) return cached;

  const invoiceCurrency = normalizeCurrency(invoiceAmount.currency);
  const invoiceAmountKey = exactMoneyKey(invoiceAmount);
  const invoiceDay = calendarDayNumber(invoice.revision.occurrence.value);
  const placement = (entry: SpendingPairingIndexEntry) => {
    const currencyMatches = invoiceCurrency === entry.currency;
    const tier = currencyMatches && invoiceAmountKey === entry.amountKey ? 1 as const : currencyMatches ? 2 as const : 3 as const;
    const distance = Number.isFinite(invoiceDay) && Number.isFinite(entry.purchaseDay)
      ? Math.abs(invoiceDay - entry.purchaseDay)
      : Number.POSITIVE_INFINITY;
    return { tier, distance };
  };
  const groups = new Map<string, RankGroup>();
  for (const entry of index.entries) {
    const { tier, distance } = placement(entry);
    const key = rankGroupKey(tier, distance);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { tier, distance, entries: [entry], ranked: null });
  }
  const ordered = [...groups.values()].sort((left, right) =>
    left.tier - right.tier || compareDateDistances(left.distance, right.distance));

  const similarityToSeller = merchantSimilarityTo(invoice.revision.seller.name);
  const rankGroup = (group: RankGroup) => {
    if (group.ranked) return group.ranked;
    const rows = group.entries.map((entry) => {
      const difference = group.tier === 3 ? null : exactMoneyDifference(invoiceAmount, entry.transaction.amount);
      return {
        difference,
        candidate: Object.freeze({
          transactionId: entry.transaction.transactionId,
          tier: group.tier,
          dateDistanceDays: group.distance,
          amountDifference: difference
            ? { coefficient: difference.coefficient, scale: difference.scale, currency: invoiceAmount.currency }
            : null,
          merchantSimilarity: similarityToSeller(entry.transaction.description),
        }) satisfies SpendingManualPaymentCandidate,
        amountOrder: 0n,
      };
    });
    if (group.tier === 2) {
      // Bring every difference to one scale once instead of in each comparison.
      const scale = Math.max(0, ...rows.map((row) => row.difference?.scale ?? 0));
      for (const row of rows)
        row.amountOrder = row.difference ? BigInt(row.difference.coefficient) * 10n ** BigInt(scale - row.difference.scale) : 0n;
    }
    rows.sort((left, right) => {
      if (left.amountOrder !== right.amountOrder) return left.amountOrder < right.amountOrder ? -1 : 1;
      if (left.candidate.merchantSimilarity !== right.candidate.merchantSimilarity)
        return right.candidate.merchantSimilarity - left.candidate.merchantSimilarity;
      return left.candidate.transactionId.localeCompare(right.candidate.transactionId);
    });
    group.ranked = Object.freeze(rows.map((row) => row.candidate));
    return group.ranked;
  };

  let all: readonly SpendingManualPaymentCandidate[] | null = null;
  const ranking: SpendingManualPaymentRanking = Object.freeze({
    total: index.entries.length,
    page(offset: number, limit: number) {
      const page: SpendingManualPaymentCandidate[] = [];
      let start = 0;
      for (const group of ordered) {
        if (page.length >= limit) break;
        const end = start + group.entries.length;
        if (end > offset) {
          const ranked = rankGroup(group);
          page.push(...ranked.slice(Math.max(0, offset - start), Math.max(0, offset - start) + limit - page.length));
        }
        start = end;
      }
      return Object.freeze(page);
    },
    find(transactionId: string) {
      const entry = index.entries.find((candidate) => candidate.transaction.transactionId === transactionId);
      if (!entry) return undefined;
      const { tier, distance } = placement(entry);
      const group = groups.get(rankGroupKey(tier, distance));
      return group ? rankGroup(group).find((candidate) => candidate.transactionId === transactionId) : undefined;
    },
    all() {
      all ??= Object.freeze(ordered.flatMap(rankGroup));
      return all;
    },
  });
  return cacheSpendingPairingRank(index, cacheKey, ranking);
}

function isSpendingPairingIndex(
  value: readonly SpendingMatchingTransaction[] | SpendingPairingIndex,
): value is SpendingPairingIndex {
  return !Array.isArray(value);
}

/**
 * Source-neutral ordering for the manual pairing modal. Every transaction is
 * retained; tiers only determine order, so a person can review a mismatch
 * rather than losing it to an amount filter.
 */
export function rankSpendingManualPaymentCandidates(
  invoice: SpendingMatchingInvoice,
  transactions: readonly SpendingMatchingTransaction[] | SpendingPairingIndex,
): readonly SpendingManualPaymentCandidate[] {
  if (isSpendingPairingIndex(transactions)) return spendingManualPaymentRanking(invoice, transactions).all();
  const invoiceAmount = invoiceMatchingMoney(invoice);
  if (!invoiceAmount) return Object.freeze([]);
  const similarityToSeller = merchantSimilarityTo(invoice.revision.seller.name);
  const ranked = transactions.map((transaction) => {
    const currencyMatches = sameCurrency(invoiceAmount, transaction.amount);
    const exactAmount = currencyMatches && exactMoneyEqual(invoiceAmount, transaction.amount);
    const date = transactionPurchaseDate(transaction);
    const difference = currencyMatches ? exactMoneyDifference(invoiceAmount, transaction.amount) : null;
    return {
      transactionId: transaction.transactionId,
      tier: exactAmount ? 1 as const : currencyMatches ? 2 as const : 3 as const,
      dateDistanceDays: calendarDayDistance(invoice.revision.occurrence.value, date.value),
      amountDifference: difference
        ? { coefficient: difference.coefficient, scale: difference.scale, currency: invoiceAmount.currency }
        : null,
      merchantSimilarity: similarityToSeller(transaction.description),
    } satisfies SpendingManualPaymentCandidate;
  });
  return Object.freeze(ranked.sort(compareManualCandidates));
}

/**
 * Build a reusable index for one immutable Spending data version. The index
 * owns the rank cache, so opening the same invoice again is O(1), while a new
 * data version receives a fresh cache and cannot observe stale transactions.
 */
export function createSpendingManualPairingIndex(
  dataVersion: number,
  transactions: readonly SpendingMatchingTransaction[],
): SpendingPairingIndex {
  return createSpendingPairingIndex(dataVersion, transactions);
}
