/**
 * Browser-safe Spending purchase matching primitives.
 *
 * Keep this module free of database, Electron, and canonical server imports.
 * The renderer uses the same deterministic ordering rules as the canonical
 * report builder without pulling the server-only dependency graph into Vite.
 */

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

export function compareExactDecimals(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * 10n ** BigInt(scale - left.scale);
  const b = right.coefficient * 10n ** BigInt(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function exactMoneyDifference(left: SpendingMatchingMoney, right: SpendingMatchingMoney): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const a = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale);
  const b = BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalizedDecimal({
    coefficient: (a >= b ? a - b : b - a).toString(),
    scale,
    currency: left.currency,
  });
}

function calendarDayNumber(value: string): number {
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

function normalizedMerchant(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function merchantSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizedMerchant(left), b = normalizedMerchant(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.75;
  const leftTokens = new Set(a.split(/\s+/u)), rightTokens = new Set(b.split(/\s+/u));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

export type SpendingManualPaymentCandidate = Readonly<{
  transactionId: string;
  tier: 1 | 2 | 3;
  dateDistanceDays: number;
  amountDifference: Readonly<{ coefficient: string; scale: number; currency: string }> | null;
  merchantSimilarity: number;
}>;

/**
 * Source-neutral ordering for the manual pairing modal. Every transaction is
 * retained; tiers only determine order, so a person can review a mismatch
 * rather than losing it to an amount filter.
 */
export function rankSpendingManualPaymentCandidates(
  invoice: SpendingMatchingInvoice,
  transactions: readonly SpendingMatchingTransaction[],
): readonly SpendingManualPaymentCandidate[] {
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
  return Object.freeze(ranked.sort((left, right) => {
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
  }));
}
