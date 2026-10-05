import { createHash } from "node:crypto";
import type { CanonicalSpendingTransaction } from "./canonical-spending-contracts.ts";
import type {
  CanonicalEInvoiceItemView,
  CanonicalEInvoiceView,
} from "./einvoice-query-contract.ts";
import type {
  ExactMoney,
  SpendingCandidateView,
  SpendingDedupLinkView,
  SpendingPair,
  SpendingRefundView,
  SpendingRecognitionSnapshot,
} from "./spending-recognition-contracts.ts";
import {
  calendarDayDistance,
  exactMoneyEqual,
  exactMoneyKey,
  invoiceMatchingMoney,
  transactionPurchaseDate,
} from "../../lib/spending/purchase-matching.ts";
import {
  readPurchaseCategory,
  type PurchaseCategory,
  type PurchaseCategoryItem,
  type PurchaseItemCategorization,
} from "./purchase-category.ts";

export type PurchaseOccurrence = Readonly<{
  value: string;
  precision: "date" | "minute" | "second";
  timeZone: string;
  basis: "purchase-date" | "posting-date-fallback" | "refund-date";
}>;

/**
 * Display facts of a purchase's bank side. cardMask is only ever `****dddd`;
 * billingPeriod is the cycle of the latest statement revision that lists the
 * transaction.
 */
export type PurchasePaymentSourceFacts = Readonly<{
  cardMask: string | null;
  billingPeriod: Readonly<{ start: string; end: string }> | null;
}>;

export type PurchasePaymentSource = PurchasePaymentSourceFacts & Readonly<{
  /** The transaction's integration namespace, such as `fubon` or `cathay`. */
  institution: string;
}>;

/** Payment source facts keyed by canonical transaction id. */
export type PurchasePaymentSourceIndex = ReadonlyMap<string, PurchasePaymentSourceFacts>;

const CARD_MASK = /^[\d*xX\u2022\u00b7.\-\s]*(\d{4})$/u;

/** Reduce a stored card mask to `****dddd`; anything that is not a mask becomes null. */
export function cardMaskLastFour(value: string | null | undefined): string | null {
  const match = CARD_MASK.exec((value ?? "").trim());
  return match ? `****${match[1]}` : null;
}

export type PurchaseRecord = Readonly<{
  purchaseId: string;
  basis: "invoice" | "bank-transaction" | "linked" | "refund";
  amount: ExactMoney | null;
  occurrence: PurchaseOccurrence;
  description: string | null;
  invoice: CanonicalEInvoiceView | null;
  transaction: CanonicalSpendingTransaction | null;
  items: readonly CanonicalEInvoiceItemView[];
  possibleDuplicate: boolean;
  candidateIds: readonly string[];
  link: SpendingDedupLinkView | null;
  difference: null | Readonly<{
    invoiceAmount: ExactMoney | null;
    bankAmount: ExactMoney;
    sameCurrency: boolean;
    exactAmountEqual: boolean;
  }>;
  refund: SpendingRefundView | null;
  /** The query-time Purchase category (ADR 0038); never stored. */
  category: PurchaseCategory;
  /** Current categorization of each invoice item, by item sequence. */
  itemCategorizations: readonly PurchaseItemCategorization[];
  /**
   * Bank-side display facts. Null when the record has no transaction, or when
   * the read that composed it did not load payment sources.
   */
  paymentSource: PurchasePaymentSource | null;
}>;

/** Current item categorizations keyed by canonical invoice id. */
export type PurchaseItemCategorizationIndex = ReadonlyMap<string, readonly PurchaseItemCategorization[]>;

export type PurchaseReport = Readonly<{
  status: "ok";
  kind: "current" | "historical";
  knowledgeAt: number;
  financialAt: string | null;
  records: readonly PurchaseRecord[];
  totalsByCurrency: readonly Readonly<ExactMoney & { count: number }>[];
  totalStatus: "complete" | "includes-pending-confirmation";
  candidates: readonly SpendingCandidateView[];
}>;

export type PurchaseReportRequest = Readonly<{
  kind: "current" | "historical";
  knowledgeAt?: number;
  financialAt?: string;
  startDate?: string;
  endDate?: string;
}>;

type Decimal = { coefficient: bigint; scale: number };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const COMPACT_UUID = /^[0-9a-f]{32}$/iu;
const day = (value: string): string => value.slice(0, 10);
const key = (pair: SpendingPair): string => `${pair.invoiceId}/${pair.transactionId}`;

/** Canonical identity representation exposed by every purchase report surface. */
export function canonicalPurchaseUuid(value: string, label = "Purchase identity"): string {
  const clean = value.trim().toLowerCase();
  if (UUID.test(clean)) return clean;
  if (COMPACT_UUID.test(clean))
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
  throw new Error(`${label} must be a canonical UUID.`);
}

/** Canonicalize a pair before it is compared, hashed, or persisted. */
export function canonicalPurchasePair(pair: SpendingPair): SpendingPair {
  return {
    invoiceId: canonicalPurchaseUuid(pair.invoiceId, "Purchase invoice identity"),
    transactionId: canonicalPurchaseUuid(pair.transactionId, "Purchase transaction identity"),
  };
}

function decimal(value: { coefficient: string; scale: number }): Decimal {
  return { coefficient: BigInt(value.coefficient), scale: value.scale };
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    scale,
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
  };
}

function dateAllowed(value: string, request: PurchaseReportRequest): boolean {
  const valueDate = day(value);
  return (!request.startDate || valueDate >= request.startDate) &&
    (!request.endDate || valueDate <= request.endDate) &&
    (!request.financialAt || valueDate <= request.financialAt);
}

const invoiceMoney = invoiceMatchingMoney;

export function purchaseCategoryItems(invoice: CanonicalEInvoiceView): readonly PurchaseCategoryItem[] {
  return invoice.revision.items.map((item) => ({
    sequence: item.sequence,
    completeness: item.completeness,
    amount: item.amount ? { coefficient: item.amount.coefficient, scale: item.amount.scale, currency: item.amount.currency } : null,
  }));
}

/** Reads one record's Purchase category from its views. */
export function purchaseRecordCategory(input: Readonly<{
  basis: PurchaseRecord["basis"];
  amount: ExactMoney | null;
  invoice: CanonicalEInvoiceView | null;
  transaction: CanonicalSpendingTransaction | null;
  itemCategorizations: readonly PurchaseItemCategorization[];
}>): PurchaseCategory {
  return readPurchaseCategory({
    basis: input.basis,
    countedAmount: input.amount,
    transaction: input.transaction ? { categorization: input.transaction.categorization } : null,
    invoice: input.invoice ? { total: invoiceMoney(input.invoice), items: purchaseCategoryItems(input.invoice) } : null,
    itemCategorizations: input.itemCategorizations,
  });
}

function invoiceOccurrence(invoice: CanonicalEInvoiceView): PurchaseOccurrence {
  return {
    value: invoice.revision.occurrence.value,
    precision: invoice.revision.occurrence.precision,
    timeZone: invoice.revision.occurrence.timeZone,
    basis: invoice.revision.occurrence.origin === "source-reported"
      ? "purchase-date"
      : "posting-date-fallback",
  };
}

function bankOccurrence(transaction: CanonicalSpendingTransaction): PurchaseOccurrence {
  const date = transactionPurchaseDate(transaction);
  return {
    value: date.value,
    precision: "date",
    timeZone: "unknown",
    basis: date.basis === "consume-date" ? "purchase-date" : "posting-date-fallback",
  };
}

/** Pure deterministic hints. They never confirm or suppress a purchase. */
export function evaluateSpendingMatchCandidates(
  invoices: readonly CanonicalEInvoiceView[],
  transactions: readonly CanonicalSpendingTransaction[],
): readonly Readonly<SpendingPair & {
  candidateKey: string;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
}>[] {
  type Candidate = SpendingPair & {
    candidateKey: string;
    algorithm: string;
    algorithmVersion: string;
    similarityEvidence: Readonly<Record<string, unknown>>;
    dateDistanceDays: number;
  };
  const transactionsByMoney = new Map<string, Array<{
    transaction: CanonicalSpendingTransaction;
    date: ReturnType<typeof transactionPurchaseDate>;
  }>>();
  for (const transaction of transactions) {
    const values = transactionsByMoney.get(exactMoneyKey(transaction.amount)) ?? [];
    values.push({ transaction, date: transactionPurchaseDate(transaction) });
    transactionsByMoney.set(exactMoneyKey(transaction.amount), values);
  }
  const result: Candidate[] = [];
  for (const invoice of invoices.filter((entry) => entry.revision.state === "active")) {
    const amount = invoiceMoney(invoice);
    if (!amount) continue;
    const invoiceDate = invoice.revision.occurrence.value;
    for (const { transaction, date } of transactionsByMoney.get(exactMoneyKey(amount)) ?? []) {
      const days = calendarDayDistance(invoiceDate, date.value);
      if (!Number.isFinite(days) || days > 7) continue;
      const pair = canonicalPurchasePair({ invoiceId: invoice.invoiceId, transactionId: transaction.transactionId });
      const candidateKey = `sha256:${createHash("sha256").update(key(pair)).digest("base64url")}`;
      result.push({
        ...pair,
        candidateKey,
        algorithm: "amount-currency-date-similarity",
        algorithmVersion: "v2",
        similarityEvidence: {
          exactAmountAndCurrency: true,
          calendarDayDistance: days,
          transactionDateBasis: date.basis,
        },
        dateDistanceDays: days,
      });
    }
  }
  return Object.freeze(result
    .sort((a, b) => a.dateDistanceDays - b.dateDistanceDays || a.invoiceId.localeCompare(b.invoiceId) || a.transactionId.localeCompare(b.transactionId))
    .map(({ dateDistanceDays: _dateDistanceDays, ...candidate }) => candidate));
}

export function emptyPurchaseReport(
  kind: "current" | "historical",
  knowledgeAt = 0,
  financialAt: string | null = null,
): PurchaseReport {
  return Object.freeze({
    status: "ok",
    kind,
    knowledgeAt,
    financialAt,
    records: Object.freeze([]),
    totalsByCurrency: Object.freeze([]),
    totalStatus: "complete",
    candidates: Object.freeze([]),
  });
}

/** A transaction's payment source, or null when there is no transaction or no index was loaded. */
export function purchasePaymentSource(
  transaction: CanonicalSpendingTransaction | null,
  index: PurchasePaymentSourceIndex | undefined,
): PurchasePaymentSource | null {
  if (!transaction || !index) return null;
  const facts = index.get(canonicalPurchaseUuid(transaction.transactionId, "Purchase transaction identity"));
  return Object.freeze({
    institution: transaction.integrationNamespace,
    cardMask: facts?.cardMask ?? null,
    billingPeriod: facts?.billingPeriod ?? null,
  });
}

/** Pure report composition seam used by products and policy fixtures. */
export function composePurchaseReport(input: Readonly<{
  request: PurchaseReportRequest;
  knowledgeAt: number;
  invoices: readonly CanonicalEInvoiceView[];
  transactions: readonly CanonicalSpendingTransaction[];
  recognition: SpendingRecognitionSnapshot;
  itemCategorizations?: PurchaseItemCategorizationIndex;
  paymentSources?: PurchasePaymentSourceIndex;
}>): PurchaseReport {
  const { request, knowledgeAt, invoices, transactions, recognition } = input;
  const paymentSourceOf = (transaction: CanonicalSpendingTransaction | null): PurchasePaymentSource | null =>
    purchasePaymentSource(transaction, input.paymentSources);
  const itemCategorizationsOf = (invoiceId: string): readonly PurchaseItemCategorization[] =>
    input.itemCategorizations?.get(invoiceId) ?? [];
  const normalizedInvoices = invoices.map((item) => ({
    ...item,
    invoiceId: canonicalPurchaseUuid(item.invoiceId, "Purchase invoice identity"),
  }));
  const normalizedTransactions = transactions.map((item) => ({
    ...item,
    transactionId: canonicalPurchaseUuid(item.transactionId, "Purchase transaction identity"),
  }));
  const invoiceById = new Map(normalizedInvoices
    .filter((item) => item.revision.state === "active")
    .map((item) => [item.invoiceId, item]));
  const transactionById = new Map(normalizedTransactions.map((item) => [item.transactionId, item]));
  const linkedInvoices = new Set<string>(), linkedTransactions = new Set<string>();
  const candidatesByInvoice = new Map<string, SpendingCandidateView[]>(), candidatesByTransaction = new Map<string, SpendingCandidateView[]>();
  for (const candidate of recognition.candidates.filter((item) => item.status === "candidate")) {
    const pair = canonicalPurchasePair(candidate);
    const normalized = { ...candidate, ...pair };
    if (!invoiceById.has(pair.invoiceId) || !transactionById.has(pair.transactionId)) continue;
    (candidatesByInvoice.get(pair.invoiceId) ?? candidatesByInvoice.set(pair.invoiceId, []).get(pair.invoiceId)!).push(normalized);
    (candidatesByTransaction.get(pair.transactionId) ?? candidatesByTransaction.set(pair.transactionId, []).get(pair.transactionId)!).push(normalized);
  }
  const records: PurchaseRecord[] = [];
  for (const link of recognition.activeLinks) {
    const pair = canonicalPurchasePair(link);
    const normalizedLink = { ...link, ...pair };
    const invoice = invoiceById.get(pair.invoiceId), transaction = transactionById.get(pair.transactionId);
    if (!invoice || !transaction) continue;
    linkedInvoices.add(invoice.invoiceId); linkedTransactions.add(transaction.transactionId);
    const occurrence = invoiceOccurrence(invoice);
    if (!dateAllowed(occurrence.value, request)) continue;
    const invoiceAmount = invoiceMoney(invoice);
    const itemCategorizations = itemCategorizationsOf(invoice.invoiceId);
    records.push({
      purchaseId: `link:${link.eventId}`,
      basis: "linked",
      amount: transaction.amount,
      occurrence,
      description: invoice.revision.seller.name ?? transaction.description,
      invoice,
      transaction,
      items: invoice.revision.items,
      possibleDuplicate: false,
      candidateIds: [],
      link: normalizedLink,
      difference: {
        invoiceAmount,
        bankAmount: transaction.amount,
        sameCurrency: invoiceAmount?.currency === transaction.amount.currency,
        exactAmountEqual: invoiceAmount ? exactMoneyEqual(invoiceAmount, transaction.amount) : false,
      },
      refund: null,
      category: purchaseRecordCategory({ basis: "linked", amount: transaction.amount, invoice, transaction, itemCategorizations }),
      itemCategorizations,
      paymentSource: paymentSourceOf(transaction),
    });
  }
  for (const invoice of invoiceById.values()) {
    if (linkedInvoices.has(invoice.invoiceId)) continue;
    const occurrence = invoiceOccurrence(invoice);
    if (!dateAllowed(occurrence.value, request)) continue;
    const candidates = candidatesByInvoice.get(invoice.invoiceId) ?? [];
    const itemCategorizations = itemCategorizationsOf(invoice.invoiceId);
    records.push({
      purchaseId: `invoice:${invoice.invoiceId}`,
      basis: "invoice",
      amount: invoiceMoney(invoice),
      occurrence,
      description: invoice.revision.seller.name,
      invoice,
      transaction: null,
      items: invoice.revision.items,
      possibleDuplicate: candidates.length > 0,
      candidateIds: candidates.map((item) => item.candidateId),
      link: null,
      difference: null,
      refund: null,
      category: purchaseRecordCategory({ basis: "invoice", amount: invoiceMoney(invoice), invoice, transaction: null, itemCategorizations }),
      itemCategorizations,
      paymentSource: null,
    });
  }
  const normalizedRefunds = recognition.refunds.map((refund) => ({
    ...refund,
    transactionId: canonicalPurchaseUuid(refund.transactionId, "Purchase refund transaction identity"),
  }));
  const refundTransactions = new Set(normalizedRefunds.map((refund) => refund.transactionId));
  for (const transaction of transactionById.values()) {
    if (linkedTransactions.has(transaction.transactionId) || refundTransactions.has(transaction.transactionId)) continue;
    const occurrence = bankOccurrence(transaction);
    if (!dateAllowed(occurrence.value, request)) continue;
    const candidates = candidatesByTransaction.get(transaction.transactionId) ?? [];
    records.push({
      purchaseId: `transaction:${transaction.transactionId}`,
      basis: "bank-transaction",
      amount: transaction.amount,
      occurrence,
      description: transaction.description,
      invoice: null,
      transaction,
      items: [],
      possibleDuplicate: candidates.length > 0,
      candidateIds: candidates.map((item) => item.candidateId),
      link: null,
      difference: null,
      refund: null,
      category: purchaseRecordCategory({ basis: "bank-transaction", amount: transaction.amount, invoice: null, transaction, itemCategorizations: [] }),
      itemCategorizations: [],
      paymentSource: paymentSourceOf(transaction),
    });
  }
  for (const refund of normalizedRefunds) {
    if (!refund.amount || !refund.occurrence || !dateAllowed(refund.occurrence.value, request)) continue;
    records.push({
      purchaseId: `refund:${refund.refundId}`,
      basis: "refund",
      amount: refund.amount,
      occurrence: {
        ...refund.occurrence,
        basis: refund.occurrence.basis === "posting-date-fallback" ? "posting-date-fallback" : "refund-date",
      },
      description: "Refund",
      invoice: null,
      transaction: transactionById.get(refund.transactionId) ?? null,
      items: [],
      possibleDuplicate: false,
      candidateIds: [],
      link: null,
      difference: null,
      refund,
      category: { mode: "absent" },
      itemCategorizations: [],
      paymentSource: paymentSourceOf(transactionById.get(refund.transactionId) ?? null),
    });
  }
  const totals = new Map<string, { value: Decimal; count: number }>();
  for (const record of records) if (record.amount) {
    const old = totals.get(record.amount.currency);
    totals.set(record.amount.currency, {
      value: old ? add(old.value, decimal(record.amount)) : decimal(record.amount),
      count: (old?.count ?? 0) + 1,
    });
  }
  records.sort((a, b) => a.occurrence.value.localeCompare(b.occurrence.value) || a.purchaseId.localeCompare(b.purchaseId));
  return Object.freeze({
    status: "ok",
    kind: request.kind,
    knowledgeAt,
    financialAt: request.financialAt ?? null,
    records: Object.freeze(records),
    totalsByCurrency: Object.freeze([...totals].sort().map(([currency, entry]) => ({
      currency,
      coefficient: entry.value.coefficient.toString(),
      scale: entry.value.scale,
      count: entry.count,
    }))),
    totalStatus: records.some((item) => item.possibleDuplicate)
      ? "includes-pending-confirmation"
      : "complete",
    candidates: recognition.candidates,
  });
}
