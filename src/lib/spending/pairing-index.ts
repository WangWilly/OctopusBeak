import type {
  SpendingMatchingMoney,
  SpendingMatchingTransaction,
  SpendingManualPaymentCandidate,
} from "./purchase-matching.ts";

/**
 * The renderer should not repeatedly inspect the complete transaction DTO when
 * a pairing dialog opens.  This index contains only immutable facts needed by
 * the deterministic manual-pairing ranker.  It is intentionally independent
 * from Electron so the same seam can be used by the financial worker and by
 * focused performance checks.
 */
export type SpendingPairingIndexEntry = Readonly<{
  transaction: SpendingMatchingTransaction;
  currency: string;
  amountKey: string;
  purchaseDay: number;
}>;

export type SpendingPairingIndex = Readonly<{
  dataVersion: number;
  entries: readonly SpendingPairingIndexEntry[];
}>;

type RankCache = Map<string, readonly SpendingManualPaymentCandidate[]>;

const rankCaches = new WeakMap<object, RankCache>();

function normalizedMoney(value: SpendingMatchingMoney): Readonly<{ coefficient: bigint; scale: number }> {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function moneyKey(value: SpendingMatchingMoney): string {
  const normalized = normalizedMoney(value);
  return `${value.currency.trim().toUpperCase()}:${normalized.coefficient}:${normalized.scale}`;
}

function purchaseDay(value: string): number {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return Number.NaN;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = Date.UTC(year!, month! - 1, day!);
  return Number.isFinite(parsed) ? parsed / 86_400_000 : Number.NaN;
}

export function createSpendingPairingIndex(
  dataVersion: number,
  transactions: readonly SpendingMatchingTransaction[],
): SpendingPairingIndex {
  const entries = transactions.map((transaction) => {
    const date = transaction.consumeDate || transaction.postingDate || transaction.effectiveOn;
    return Object.freeze({
      transaction,
      currency: transaction.amount.currency.trim().toUpperCase(),
      amountKey: moneyKey(transaction.amount),
      purchaseDay: purchaseDay(date),
    });
  });
  const index = Object.freeze({
    dataVersion,
    entries: Object.freeze(entries),
  });
  rankCaches.set(index, new Map());
  return index;
}

export function cachedSpendingPairingRank(
  index: SpendingPairingIndex,
  key: string,
): readonly SpendingManualPaymentCandidate[] | undefined {
  return rankCaches.get(index)?.get(key);
}

export function cacheSpendingPairingRank(
  index: SpendingPairingIndex,
  key: string,
  value: readonly SpendingManualPaymentCandidate[],
): readonly SpendingManualPaymentCandidate[] {
  const cache = rankCaches.get(index);
  if (!cache) throw new Error("Spending pairing index is not initialized.");
  cache.set(key, value);
  return value;
}

export class SpendingPairingIndexCache {
  private current: SpendingPairingIndex | null = null;

  forVersion(dataVersion: number): SpendingPairingIndex | null {
    return this.current?.dataVersion === dataVersion ? this.current : null;
  }

  get(
    dataVersion: number,
    transactions: readonly SpendingMatchingTransaction[],
  ): Readonly<{ index: SpendingPairingIndex; reused: boolean }> {
    if (this.current?.dataVersion === dataVersion) return { index: this.current, reused: true };
    const index = createSpendingPairingIndex(dataVersion, transactions);
    this.current = index;
    return { index, reused: false };
  }

  get currentVersion(): number | null {
    return this.current?.dataVersion ?? null;
  }
}
