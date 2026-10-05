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
} from "./spending-pairing-index.ts";
import { merchantSimilarity } from "./spending-match-strength.ts";

export type { SpendingPairingIndex } from "./spending-pairing-index.ts";

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function normalizedDecimal(value: SpendingMatchingMoney): Decimal {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function compareExactDecimals(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * 10n ** BigInt(scale - left.scale);
  const b = right.coefficient * 10n ** BigInt(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function exactMoneyDifference(left: SpendingMatchingMoney, right: SpendingMatchingMoney): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const a = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale);
  const b = BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalizedDecimal({
    coefficient: (a >= b ? a - b : b - a).toString(),
    scale,
    currency: left.currency,
  });
}

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
    const amountOrder = compareExactDecimals(
      { coefficient: BigInt(left.amountDifference?.coefficient ?? "0"), scale: left.amountDifference?.scale ?? 0 },
      { coefficient: BigInt(right.amountDifference?.coefficient ?? "0"), scale: right.amountDifference?.scale ?? 0 },
    );
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

function rankIndexedManualPaymentCandidates(
  invoice: SpendingMatchingInvoice,
  index: SpendingPairingIndex,
): readonly SpendingManualPaymentCandidate[] {
  const invoiceAmount = invoiceMatchingMoney(invoice);
  if (!invoiceAmount) return Object.freeze([]);
  const cacheKey = manualCandidateCacheKey(invoice);
  const cached = cachedSpendingPairingRank(index, cacheKey);
  if (cached) return cached;

  const invoiceCurrency = invoiceAmount.currency.trim().toUpperCase();
  const invoiceAmountKey = exactMoneyKey(invoiceAmount);
  const invoiceDay = calendarDayNumber(invoice.revision.occurrence.value);
  const buckets = new Map<string, {
    tier: 1 | 2 | 3;
    distance: number;
    candidates: SpendingManualPaymentCandidate[];
  }>();
  for (const entry of index.entries) {
    const sameCurrency = invoiceCurrency === entry.currency;
    const exactAmount = sameCurrency && invoiceAmountKey === entry.amountKey;
    const tier = exactAmount ? 1 as const : sameCurrency ? 2 as const : 3 as const;
    const distance = Number.isFinite(invoiceDay) && Number.isFinite(entry.purchaseDay)
      ? Math.abs(invoiceDay - entry.purchaseDay)
      : Number.POSITIVE_INFINITY;
    const difference = sameCurrency ? exactMoneyDifference(invoiceAmount, entry.transaction.amount) : null;
    const candidate = {
      transactionId: entry.transaction.transactionId,
      tier,
      dateDistanceDays: distance,
      amountDifference: difference
        ? { coefficient: difference.coefficient.toString(), scale: difference.scale, currency: invoiceAmount.currency }
        : null,
      merchantSimilarity: merchantSimilarity(invoice.revision.seller.name, entry.transaction.description),
    } satisfies SpendingManualPaymentCandidate;
    const key = `${tier}:${Number.isFinite(distance) ? distance : "infinity"}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.candidates.push(candidate);
    else buckets.set(key, { tier, distance, candidates: [candidate] });
  }

  const ordered = [...buckets.values()].sort((left, right) =>
    left.tier - right.tier || compareDateDistances(left.distance, right.distance));
  const ranked: SpendingManualPaymentCandidate[] = [];
  for (const bucket of ordered) {
    bucket.candidates.sort(compareManualCandidates);
    ranked.push(...bucket.candidates);
  }
  return cacheSpendingPairingRank(index, cacheKey, Object.freeze(ranked));
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
  if (isSpendingPairingIndex(transactions)) return rankIndexedManualPaymentCandidates(invoice, transactions);
  const invoiceAmount = invoiceMatchingMoney(invoice);
  if (!invoiceAmount) return Object.freeze([]);
  const invoiceDescription = invoice.revision.seller.name;
  const ranked = transactions.map((transaction) => {
    const sameCurrency = invoiceAmount.currency.trim().toUpperCase() === transaction.amount.currency.trim().toUpperCase();
    const exactAmount = sameCurrency && exactMoneyEqual(invoiceAmount, transaction.amount);
    const date = transactionPurchaseDate(transaction);
    const difference = sameCurrency ? exactMoneyDifference(invoiceAmount, transaction.amount) : null;
    return {
      transactionId: transaction.transactionId,
      tier: exactAmount ? 1 as const : sameCurrency ? 2 as const : 3 as const,
      dateDistanceDays: calendarDayDistance(invoice.revision.occurrence.value, date.value),
      amountDifference: difference
        ? { coefficient: difference.coefficient.toString(), scale: difference.scale, currency: invoiceAmount.currency }
        : null,
      merchantSimilarity: merchantSimilarity(invoiceDescription, transaction.description),
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
