/**
 * Browser-safe Spending purchase matching primitives.
 *
 * Keep this module free of database, Electron, and canonical server imports.
 * The renderer uses the same deterministic ordering rules as the canonical
 * report builder without pulling the server-only dependency graph into Vite.
 */

import type {
  PurchaseCategory,
  PurchaseItemCategorization,
} from "./purchase-category-view.ts";

export type SpendingPurchaseCategoryView = PurchaseCategory;
export type SpendingPurchaseItemCategorizationView = PurchaseItemCategorization;

export type SpendingMatchingMoney = Readonly<{
  coefficient: string;
  scale: number;
  currency: string;
}>;

export type SpendingMatchingTransaction = Readonly<{
  transactionId: string;
  effectiveOn: string;
  consumeDate?: string | null;
  postingDate?: string | null;
  description: string | null;
  amount: SpendingMatchingMoney;
}>;

export type SpendingMatchingInvoice = Readonly<{
  revision: Readonly<{
    seller: Readonly<{ name: string | null }>;
    occurrence: Readonly<{ value: string }>;
    total: SpendingMatchingMoney | null;
  }>;
}>;

export type SpendingPurchaseOccurrence = Readonly<{
  value: string;
  precision: "date" | "minute" | "second";
  timeZone: string;
  basis: "purchase-date" | "posting-date-fallback" | "refund-date";
}>;

export type SpendingPurchaseItemView = Readonly<{
  itemId: string;
  name: string | null;
  quantity: Readonly<{ coefficient: string; scale: number }> | null;
  amount: SpendingMatchingMoney | null;
  sourceFacts: Readonly<Record<string, unknown>>;
}>;

export type SpendingPurchaseInvoiceView = Readonly<{
  invoiceId: string;
  revision: Readonly<{
    seller: Readonly<{ name: string | null }>;
    occurrence: Readonly<{ value: string }>;
    total: SpendingMatchingMoney | null;
    items: readonly SpendingPurchaseItemView[];
  }>;
}>;

export type SpendingPurchaseTransactionView = SpendingMatchingTransaction & Readonly<{
  stream: string;
  effectiveDateBasis?: "consume-date" | "posting-date-fallback" | null;
}>;

export type SpendingPurchaseLinkView = Readonly<{
  invoiceId: string;
  transactionId: string;
  eventId: string;
  origin: string;
  evidenceKnowledgeSequence: number;
  decidedAt: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingPurchaseRecordView = Readonly<{
  purchaseId: string;
  basis: "invoice" | "bank-transaction" | "linked" | "refund";
  amount: SpendingMatchingMoney | null;
  occurrence: SpendingPurchaseOccurrence;
  description: string | null;
  invoice: SpendingPurchaseInvoiceView | null;
  transaction: SpendingPurchaseTransactionView | null;
  items: readonly SpendingPurchaseItemView[];
  possibleDuplicate: boolean;
  candidateIds: readonly string[];
  link: SpendingPurchaseLinkView | null;
  difference: Readonly<{
    invoiceAmount: SpendingMatchingMoney | null;
    bankAmount: SpendingMatchingMoney;
    sameCurrency: boolean;
    exactAmountEqual: boolean;
  }> | null;
  refund: Readonly<{ provenanceReference: string }> | null;
  category: SpendingPurchaseCategoryView;
  itemCategorizations: readonly SpendingPurchaseItemCategorizationView[];
  /** Null without a transaction or when the read did not load payment sources. */
  paymentSource: SpendingPaymentSourceView | null;
}>;

/** The bank side's display facts; cardMask is only ever `****dddd`. */
export type SpendingPaymentSourceView = Readonly<{
  institution: string;
  cardMask: string | null;
  billingPeriod: Readonly<{ start: string; end: string }> | null;
}>;

export type SpendingPurchaseCandidateView = Readonly<{
  candidateId: string;
  algorithm: string;
  algorithmVersion: string;
  status: "candidate" | "confirmed" | "denied" | "revoked";
}>;

export type SpendingPurchaseReportView = Readonly<{
  status: "ok";
  kind: "current" | "historical";
  knowledgeAt: number;
  financialAt: string | null;
  records: readonly SpendingPurchaseRecordView[];
  totalsByCurrency: readonly Readonly<SpendingMatchingMoney & { count: number }>[];
  totalStatus: "complete" | "includes-pending-confirmation";
  candidates: readonly SpendingPurchaseCandidateView[];
}>;

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function decimal(value: SpendingMatchingMoney): Decimal {
  return { coefficient: BigInt(value.coefficient), scale: value.scale };
}

function normalizedDecimal(value: SpendingMatchingMoney): Decimal {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function exactMoneyEqual(left: SpendingMatchingMoney, right: SpendingMatchingMoney): boolean {
  if (left.currency.trim().toUpperCase() !== right.currency.trim().toUpperCase()) return false;
  const a = decimal(left), b = decimal(right), scale = Math.max(a.scale, b.scale);
  return a.coefficient * 10n ** BigInt(scale - a.scale) === b.coefficient * 10n ** BigInt(scale - b.scale);
}

export function exactMoneyKey(value: SpendingMatchingMoney): string {
  const normalized = normalizedDecimal(value);
  return `${value.currency.trim().toUpperCase()}:${normalized.coefficient}:${normalized.scale}`;
}

export function calendarDayNumber(value: string): number {
  const date = value.slice(0, 10);
  if (!ISO_DATE.test(date)) return Number.NaN;
  const [year, month, dateOfMonth] = date.split("-").map(Number);
  const parsed = Date.UTC(year!, month! - 1, dateOfMonth!);
  return Number.isFinite(parsed) ? parsed / 86_400_000 : Number.NaN;
}

export function calendarDayDistance(left: string, right: string): number {
  const a = calendarDayNumber(left), b = calendarDayNumber(right);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : Number.POSITIVE_INFINITY;
}

export function transactionPurchaseDate(
  transaction: Pick<SpendingMatchingTransaction, "effectiveOn"> &
    Partial<Pick<SpendingMatchingTransaction, "consumeDate" | "postingDate">>,
): Readonly<{
  value: string;
  basis: "consume-date" | "posting-date-fallback" | "effective-date";
}> {
  if (transaction.consumeDate) return { value: transaction.consumeDate, basis: "consume-date" };
  if (transaction.postingDate) return { value: transaction.postingDate, basis: "posting-date-fallback" };
  return { value: transaction.effectiveOn, basis: "effective-date" };
}

export function invoiceMatchingMoney(invoice: SpendingMatchingInvoice): SpendingMatchingMoney | null {
  const total = invoice.revision.total;
  return total
    ? { coefficient: String(total.coefficient), scale: total.scale, currency: total.currency }
    : null;
}
