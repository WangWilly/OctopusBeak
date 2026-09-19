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
  purchaseDate: string;
  purchaseDay: number;
}>;

export type SpendingPairingIndex = Readonly<{
  dataVersion: number;
  transactionFingerprint: string;
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

function purchaseDate(transaction: SpendingMatchingTransaction): string {
  return transaction.consumeDate || transaction.postingDate || transaction.effectiveOn;
}

function purchaseDay(value: string): number {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return Number.NaN;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = Date.UTC(year!, month! - 1, day!);
  return Number.isFinite(parsed) ? parsed / 86_400_000 : Number.NaN;
}

function transactionFingerprint(transaction: SpendingMatchingTransaction): string {
  return JSON.stringify([
    transaction.transactionId,
    transaction.effectiveOn,
    transaction.consumeDate ?? null,
    transaction.postingDate ?? null,
    transaction.description ?? null,
    transaction.amount.coefficient,
    transaction.amount.scale,
    transaction.amount.currency,
  ]);
}

export function spendingPairingTransactionFingerprint(
  transactions: readonly SpendingMatchingTransaction[],
): string {
  return transactions.map(transactionFingerprint).join("\u0001");
}

export function createSpendingPairingIndex(
  dataVersion: number,
  transactions: readonly SpendingMatchingTransaction[],
): SpendingPairingIndex {
  const entries = transactions.map((transaction) => {
    const date = purchaseDate(transaction);
    return Object.freeze({
      transaction,
      currency: transaction.amount.currency.trim().toUpperCase(),
      amountKey: moneyKey(transaction.amount),
      purchaseDate: date,
      purchaseDay: purchaseDay(date),
    });
  });
  const index = Object.freeze({
    dataVersion,
    transactionFingerprint: spendingPairingTransactionFingerprint(transactions),
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

  get(
    dataVersion: number,
    transactions: readonly SpendingMatchingTransaction[],
  ): Readonly<{ index: SpendingPairingIndex; reused: boolean }> {
    const fingerprint = spendingPairingTransactionFingerprint(transactions);
    if (
      this.current &&
      this.current.dataVersion === dataVersion &&
      this.current.transactionFingerprint === fingerprint
    ) return { index: this.current, reused: true };
    const index = createSpendingPairingIndex(dataVersion, transactions);
    this.current = index;
    return { index, reused: false };
  }

  invalidate(dataVersion?: number): void {
    if (dataVersion === undefined || this.current?.dataVersion === dataVersion)
      this.current = null;
  }

  get currentVersion(): number | null {
    return this.current?.dataVersion ?? null;
  }
}
