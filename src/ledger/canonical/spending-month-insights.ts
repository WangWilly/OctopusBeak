import type { ExactMoney } from "./spending-recognition-contracts.ts";

/** One counted, non-refund purchase of a month with the facts that identify its merchant. */
export type MonthPurchaseFact = Readonly<{
  purchaseId: string;
  basis: "invoice" | "bank-transaction" | "linked";
  occurrence: string;
  amount: ExactMoney | null;
  sellerTaxId: string | null;
  sellerName: string | null;
  bankDescription: string | null;
}>;

/**
 * Who a purchase was made with, by exact identity only (ADR 0011): the seller
 * tax ID when an invoice backs the purchase, otherwise the normalized bank
 * description. The two kinds never match each other.
 */
export type MerchantIdentity =
  | Readonly<{ kind: "seller-tax-id"; taxId: string }>
  | Readonly<{ kind: "bank-description"; description: string }>;

export type LargestPurchase = Readonly<{
  purchaseId: string;
  amount: ExactMoney;
  occurrence: string;
  merchantLabel: string | null;
}>;

export type SameMerchantStats = Readonly<{
  merchant: MerchantIdentity;
  merchantLabel: string | null;
  /** Purchases of the month with this merchant, including the given one. */
  count: number;
  totalsByCurrency: readonly Readonly<ExactMoney & { count: number }>[];
}>;

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function scaled(value: Decimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function compareMoney(left: ExactMoney, right: ExactMoney): number {
  const a = { coefficient: BigInt(left.coefficient), scale: left.scale };
  const b = { coefficient: BigInt(right.coefficient), scale: right.scale };
  const scale = Math.max(a.scale, b.scale);
  const difference = scaled(a, scale) - scaled(b, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function reduced(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

/** NFKC, case-folded, whitespace-collapsed text; empty text has no identity. */
export function normalizedBankDescription(value: string | null | undefined): string | null {
  const normalized = (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return normalized === "" ? null : normalized;
}

export function merchantIdentity(fact: MonthPurchaseFact): MerchantIdentity | null {
  if (fact.basis !== "bank-transaction") {
    const taxId = fact.sellerTaxId?.trim();
    return taxId ? { kind: "seller-tax-id", taxId } : null;
  }
  const description = normalizedBankDescription(fact.bankDescription);
  return description ? { kind: "bank-description", description } : null;
}

function merchantKey(identity: MerchantIdentity): string {
  return identity.kind === "seller-tax-id" ? `tax:${identity.taxId}` : `bank:${identity.description}`;
}

export function merchantLabel(fact: MonthPurchaseFact): string | null {
  return fact.basis === "bank-transaction" ? fact.bankDescription : fact.sellerName ?? fact.bankDescription;
}

/** The month's single largest purchase in each currency; ties go to the later purchase. */
export function largestPurchasesByCurrency(facts: readonly MonthPurchaseFact[]): readonly LargestPurchase[] {
  const best = new Map<string, MonthPurchaseFact & { amount: ExactMoney }>();
  for (const fact of facts) {
    if (!fact.amount) continue;
    const currency = fact.amount.currency.toUpperCase();
    const current = best.get(currency);
    const order = current ? compareMoney(fact.amount, current.amount) : 1;
    if (!current || order > 0 || (order === 0 && (fact.occurrence > current.occurrence
        || (fact.occurrence === current.occurrence && fact.purchaseId < current.purchaseId))))
      best.set(currency, fact as MonthPurchaseFact & { amount: ExactMoney });
  }
  return Object.freeze([...best.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, fact]) => Object.freeze({
      purchaseId: fact.purchaseId,
      amount: fact.amount,
      occurrence: fact.occurrence,
      merchantLabel: merchantLabel(fact),
    })));
}

/** Count and total the month's purchases that share the given purchase's merchant identity. */
export function sameMerchantStats(facts: readonly MonthPurchaseFact[], purchaseId: string): SameMerchantStats | null {
  const target = facts.find((fact) => fact.purchaseId === purchaseId);
  const identity = target ? merchantIdentity(target) : null;
  if (!target || !identity) return null;
  const key = merchantKey(identity);
  const matching = facts.filter((fact) => {
    const other = merchantIdentity(fact);
    return other !== null && merchantKey(other) === key;
  });
  const totals = new Map<string, { amount: Decimal; count: number }>();
  for (const fact of matching) {
    if (!fact.amount) continue;
    const currency = fact.amount.currency.toUpperCase();
    const amount = { coefficient: BigInt(fact.amount.coefficient), scale: fact.amount.scale };
    const previous = totals.get(currency);
    if (!previous) {
      totals.set(currency, { amount, count: 1 });
      continue;
    }
    const scale = Math.max(previous.amount.scale, amount.scale);
    totals.set(currency, {
      amount: { coefficient: scaled(previous.amount, scale) + scaled(amount, scale), scale },
      count: previous.count + 1,
    });
  }
  return Object.freeze({
    merchant: Object.freeze(identity),
    merchantLabel: merchantLabel(target),
    count: matching.length,
    totalsByCurrency: Object.freeze([...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, total]) => {
        const value = reduced(total.amount);
        return Object.freeze({ currency, coefficient: value.coefficient.toString(), scale: value.scale, count: total.count });
      })),
  });
}
