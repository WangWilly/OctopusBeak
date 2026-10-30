import type { PurchaseReport } from "../../ledger/canonical/spending-purchase-report.ts";
import {
  addToTotals,
  exactToNumber,
  isZeroExact,
  negateMoney,
  normalizeCurrency,
  parseExactMoney,
  readTotals,
  type ExactMoney,
  type MoneyTotalsAccumulator,
} from "../shared-money/exact-money.ts";
import type { PurchaseCategory } from "./purchase-category-view.ts";
import type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
import type { SpendingPurchaseReportView } from "./purchase-matching.ts";
import type {
  SpendingCandidateReasons,
  SpendingCandidateStrength,
} from "../../ledger/canonical/spending-match-strength.ts";
import type { MerchantIdentity } from "../../ledger/canonical/spending-month-insights.ts";
export type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
export type {
  SpendingCandidateReasons,
  SpendingCandidateStrength,
} from "../../ledger/canonical/spending-match-strength.ts";

/**
 * The purchase-basis report is the active Spending contract.  It stays as a
 * canonical typed report instead of flattening exact money or source evidence
 * into presentation-only numbers.
 */
export type SpendingPurchaseReportSummaryDto = Readonly<{
  recordCount: number;
  /** Counts are null until the version-bound candidate view is loaded. */
  candidateCount: number | null;
  pendingCandidateCount: number | null;
  candidateState: "unloaded" | "ready";
  currencies: readonly string[];
  totalsByCurrency: readonly Readonly<{
    currency: string;
    coefficient: string;
    scale: number;
    count: number;
  }> [];
  monthTotals: readonly Readonly<{
    month: string;
    recordCount: number;
    activeDayCount: number;
    pendingCandidateCount: number | null;
    totalsByCurrency: readonly Readonly<{
      currency: string;
      coefficient: string;
      scale: number;
      count: number;
    }> [];
  }> [];
  dayTotals: readonly Readonly<{
    month: string;
    date: string;
    recordCount: number;
    totalsByCurrency: readonly Readonly<{
      currency: string;
      coefficient: string;
      scale: number;
      count: number;
    }> [];
  }> [];
  /**
   * Per-month Purchase category totals (ADR 0038), keyed by canonical code.
   * `categoryCode: null` is the query-time Unclassified bucket. A split
   * purchase counts once per touched code with that code's amount.
   */
  categoryTotalsByMonth: readonly SpendingCategoryMonthTotal[];
}>;

export type SpendingCategoryMonthTotal = Readonly<{
  month: string;
  currency: string;
  categoryCode: string | null;
  coefficient: string;
  scale: number;
  count: number;
}>;

/** The record-page selector for purchases whose Purchase category is absent. */
export const SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR = "unclassified" as const;

export type SpendingPurchaseReportDto = PurchaseReport & Readonly<{
  /** Present on the compact active-page response; omitted by legacy full reads. */
  summary?: SpendingPurchaseReportSummaryDto;
}>;

/** Compact current-page envelope. Its knowledge point is shared by every
 * record and candidate page requested from this summary. */
export type SpendingSummaryDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  availability: "empty" | "available";
  inclusionPolicy: Readonly<{ id: "gross-posted-outflow"; version: "v1"; name: "Gross posted outflow" }>;
  purchaseReport: SpendingPurchaseReportSummaryDto & Readonly<{
    kind: "current";
    financialAt: null;
    status: "ok";
    totalStatus: "complete" | "includes-pending-confirmation";
  }>;
  }>;

/**
 * Months the Spending page can open, oldest first: every month with data plus
 * today's month, which is the page's default even before it has a purchase.
 */
export function spendingMonths(dataMonths: readonly string[], todayMonth: string): readonly string[] {
  return Object.freeze([...new Set([...dataMonths, todayMonth])].sort());
}

/** Preserve a user's month/day selection when a compact summary version changes. */
export function preserveSpendingMonthSelection(
  previousSummary: Pick<SpendingPurchaseReportSummaryDto, "monthTotals"> | undefined,
  nextSummary: Pick<SpendingPurchaseReportSummaryDto, "monthTotals"> | undefined,
  selectedMonth: string | null,
  selectedDay: string | null,
  todayMonth: string,
): Readonly<{ selectedMonth: string | null; selectedDay: string | null }> {
  if (!previousSummary || !nextSummary) return { selectedMonth: null, selectedDay: null };
  const months = spendingMonths(nextSummary.monthTotals.map((month) => month.month), todayMonth);
  if (selectedMonth !== null && !months.includes(selectedMonth)) return { selectedMonth: null, selectedDay: null };
  const activeMonth = selectedMonth ?? todayMonth;
  return {
    selectedMonth,
    selectedDay: selectedDay?.startsWith(`${activeMonth}-`) ? selectedDay : null,
  };
}

export type SpendingRecordPageRequest = Readonly<{
  knowledgeAt: number;
  month?: string | null;
  day?: string | null;
  cursor?: string | null;
  limit?: number;
  /** Canonical codes, or SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR; the renderer expands display groups. */
  categoryCodes?: readonly string[] | null;
  /**
   * Search within the month: a case-insensitive substring of the invoice
   * seller or bank description, or an exact counted amount such as `1,444`.
   * Requires month.
   */
  query?: string | null;
  /** `linked` lists only merged purchases (已合併). */
  basis?: SpendingRecordBasisFilter | null;
}>;

export type SpendingRecordBasisFilter = "linked";

/** Change one purchase's category (ADR 0038). A null code clears the user lineage. */
export type SpendingPurchaseCategoryRequest = Readonly<{
  purchaseId: string;
  knowledgeAt: number;
  categoryCode: string | null;
}>;

export type SpendingPurchaseCategoryResult = Readonly<{
  purchaseId: string;
  /** The subject that received the User Assertions: the transaction, or every invoice item. */
  subject: "transaction" | "items";
  categoryCode: string | null;
  baseKnowledgeAt: number;
  /** Equal to baseKnowledgeAt when the request changed nothing. */
  knowledgeAt: number;
}>;

export type SpendingRecordPageDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  month: string | null;
  day: string | null;
  categoryCodes: readonly string[] | null;
  query: string | null;
  basis: SpendingRecordBasisFilter | null;
  records: readonly SpendingPurchaseReportView["records"][number][];
  nextCursor: string | null;
}>;

export type SpendingCandidatePageRequest = Readonly<{
  knowledgeAt: number;
  /** A calendar month for the month panel, or null for every pending pair (the merge modal). */
  month: string | null;
  offset?: number;
  limit?: number;
}>;

/** A pending pair as shown: strength and reasons are read-time, never stored. */
export type SpendingPendingCandidateView = SpendingPurchaseReportView["candidates"][number] & Readonly<{
  invoiceId: string;
  transactionId: string;
  strength: SpendingCandidateStrength;
  reasons: SpendingCandidateReasons;
}>;

export type SpendingCandidatePageItem = Readonly<{
  candidate: SpendingPendingCandidateView;
  invoiceRecord: SpendingPurchaseReportView["records"][number] | null;
  paymentRecord: SpendingPurchaseReportView["records"][number] | null;
}>;

export type SpendingCandidatePageDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  month: string | null;
  items: readonly SpendingCandidatePageItem[];
  /** Pending pairs in the requested scope: the month, or every month when month is null. */
  totalCandidateCount: number;
  /** Strong pairs in the requested scope. */
  strongCandidateCount: number;
  nextOffset: number | null;
}>;

/** One pair the user was shown, by identity. */
export type SpendingCandidatePairRef = Readonly<{
  candidateId: string;
  invoiceIdentityId: string;
  transactionIdentityId: string;
}>;

/** The global pending pairing state behind the top-bar 帳目合併 N and the merge modal header. */
export type SpendingPendingOverviewDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  /** Pending pairs across all months. */
  pendingCount: number;
  strongCount: number;
  /** Invoice amounts at stake, once per distinct invoice with a pending pair; count is invoices. */
  affectedByCurrency: readonly Readonly<{ currency: string; coefficient: string; scale: number; count: number }>[];
  /** The 合併所有高度相符 set, in display order. */
  strongPairs: readonly SpendingCandidatePairRef[];
}>;

export type SpendingPendingOverviewRequest = Readonly<{
  knowledgeAt: number;
  /** `YYYY-MM`: only pairs whose invoice or payment falls in the month. Omitted means every month. */
  month?: string | null;
}>;

export type SpendingMergeLogRequest = Readonly<{
  knowledgeAt: number;
  cursor?: string | null;
  limit?: number;
}>;

export type SpendingMoneyDto = Readonly<{ currency: string; coefficient: string; scale: number }>;

/** One 合併紀錄 row: a decision event with the current display facts of both sides. */
export type SpendingMergeLogEntry = Readonly<{
  eventId: string;
  kind: "confirmed" | "denied" | "revoked";
  origin: "user" | "source";
  decidedAt: string;
  commitSequence: number;
  invoice: Readonly<{
    invoiceId: string;
    invoiceNumber: string;
    sellerName: string | null;
    occurrence: string;
    amount: SpendingMoneyDto | null;
  }> | null;
  payment: Readonly<{
    transactionId: string;
    description: string | null;
    date: string;
    amount: SpendingMoneyDto;
    institution: string;
    /** Only ever `****dddd`. */
    cardMask: string | null;
  }> | null;
}>;

export type SpendingMergeLogDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  /** Newest decision first. */
  entries: readonly SpendingMergeLogEntry[];
  nextCursor: string | null;
}>;

export type SpendingMonthInsightRequest = Readonly<{ knowledgeAt: number; month: string }>;

/** 最高消費: the month's single largest purchase in one currency. */
export type SpendingLargestPurchaseDto = Readonly<{
  purchaseId: string;
  amount: SpendingMoneyDto;
  occurrence: string;
  merchantLabel: string | null;
}>;

export type SpendingMonthInsightDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  month: string;
  largestByCurrency: readonly SpendingLargestPurchaseDto[];
}>;

export type SpendingMerchantStatsRequest = Readonly<{
  knowledgeAt: number;
  purchaseId: string;
  /** `YYYY-MM` the caller saw the purchase in; lets the read scope to one month. */
  month?: string | null;
}>;

/** Exact merchant identity: seller tax ID for invoice-backed purchases, normalized bank text otherwise. */
export type SpendingMerchantIdentity = MerchantIdentity;

/** 本月同商家: purchases in the given purchase's month with the same merchant identity. */
export type SpendingMerchantStatsDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  purchaseId: string;
  /** Null, with a zero count, when the purchase is no longer current at this version. */
  month: string | null;
  /** Null when the purchase has no merchant identity (no tax ID or blank description). */
  merchant: SpendingMerchantIdentity | null;
  merchantLabel: string | null;
  /** Includes the given purchase. */
  count: number;
  totalsByCurrency: readonly Readonly<{ currency: string; coefficient: string; scale: number; count: number }>[];
}>;

/** 合併所有高度相符: confirm exactly the strong pairs the user was shown. */
export type SpendingStrongConfirmRequest = Readonly<{
  /** The data version the shown pairs came from; a newer unrelated commit does not reject. */
  shownKnowledgeAt: number;
  /** `YYYY-MM`: the strong set is recomputed inside this month only. Omitted means every month. */
  month?: string | null;
  pairs: readonly SpendingCandidatePairRef[];
}>;

export type SpendingStrongConfirmResult =
  | Readonly<{
      status: "committed";
      baseKnowledgeAt: number;
      /** The one commit holding every decision event of the batch. */
      knowledgeAt: number;
      confirmed: readonly (SpendingCandidatePairRef & Readonly<{ eventId: string }>)[];
    }>
  | Readonly<{
      /** Nothing was written: a shown pair is no longer pending or no longer strong. */
      status: "conflict";
      knowledgeAt: number;
      conflicts: readonly SpendingCandidatePairRef[];
      /** The recomputed strong set to offer instead. */
      strongPairs: readonly SpendingCandidatePairRef[];
    }>;

/** Worker-validated action from a compact, version-bound Spending page. */
export type SpendingPageActionRequest = Readonly<{
  action: "confirm" | "deny";
  kind: "candidate";
  candidateId: string;
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}> | Readonly<{
  action: "confirm";
  kind: "direct";
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}> | Readonly<{
  action: "revoke";
  kind: "revoke";
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}>;

export type SpendingPageActionResult = Readonly<{
  action: SpendingPageActionRequest["action"];
  kind: SpendingPageActionRequest["kind"];
  /** The compact summary version the action validated before writing. */
  baseKnowledgeAt: number;
  /** The exact version containing this action's committed change. */
  knowledgeAt: number;
  invoiceIdentityId: string;
  transactionIdentityId: string;
  /** Purchase rows before/after the action; their amounts use exact decimals. */
  summaryDelta: Readonly<{
    before: readonly SpendingSummaryDeltaLine[];
    after: readonly SpendingSummaryDeltaLine[];
  }>;
  /** Only rows that contain either member of the acted pair. */
  affectedRecords: readonly PurchaseReport["records"][number][];
}>;

export type SpendingSummaryDeltaLine = Readonly<{
  date: string;
  amount: Readonly<{ currency: string; coefficient: string; scale: number }> | null;
  category: PurchaseCategory;
}>;

/**
 * Summary totals after a delta, through the shared money totals so the
 * renderer reads what the server would compute: currency upper-cased, amounts
 * reduced, and a total kept while it still counts a record.
 */
function signedSummaryAmount(value: unknown, direction: 1 | -1): ExactMoney {
  const amount = parseExactMoney(value, "Spending summary amount");
  return direction === 1 ? amount : negateMoney(amount);
}

function summaryCount(count: number, direction: 1 | -1): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Spending summary amount is invalid.");
  return direction * count;
}

function categoryTotalsAfter(
  rows: readonly SpendingCategoryMonthTotal[],
  lines: readonly Readonly<{ line: SpendingSummaryDeltaLine; direction: 1 | -1 }>[],
): readonly SpendingCategoryMonthTotal[] {
  const values: MoneyTotalsAccumulator = new Map();
  const groups = new Map<string, { month: string; categoryCode: string | null }>();
  const add = (month: string, categoryCode: string | null, amount: SpendingMoneyDto, count: number, direction: 1 | -1) => {
    const key = `${month}|${normalizeCurrency(amount.currency)}|${categoryCode ?? ""}`;
    groups.set(key, { month, categoryCode });
    addToTotals(values, signedSummaryAmount(amount, direction), () => key, summaryCount(count, direction));
    if (values.get(key)!.count < 0) throw new Error("Spending summary delta removed a missing category amount.");
  };
  for (const row of rows) add(row.month, row.categoryCode, row, row.count, 1);
  for (const { line, direction } of lines) {
    if (!line.amount) continue;
    const month = line.date.slice(0, 7);
    if (line.category.mode === "split") {
      for (const component of line.category.components)
        add(month, component.categoryCode, component.amount, 1, direction);
      continue;
    }
    add(month, line.category.mode === "single" ? line.category.categoryCode : null, line.amount, 1, direction);
  }
  return Object.freeze(readTotals(values).map(({ key, currency, coefficient, scale, count }) => Object.freeze({
    month: groups.get(key)!.month,
    currency,
    categoryCode: groups.get(key)!.categoryCode,
    coefficient,
    scale,
    count,
  })));
}

const SPENDING_SUMMARY_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function summaryMoneyAfter(
  rows: readonly Readonly<{ currency: string; coefficient: string; scale: number; count: number }>[],
  deltas: readonly Readonly<{ amount: SpendingSummaryDeltaLine["amount"]; direction: 1 | -1 }>[],
) {
  const values: MoneyTotalsAccumulator = new Map();
  const add = (amount: SpendingMoneyDto, count: number, direction: 1 | -1) => {
    const signed = signedSummaryAmount(amount, direction);
    const currency = normalizeCurrency(signed.currency);
    addToTotals(values, signed, () => currency, summaryCount(count, direction));
    if (values.get(currency)!.count < 0) throw new Error("Spending summary delta removed a missing amount.");
  };

  for (const row of rows) add(row, row.count, 1);
  for (const delta of deltas) {
    if (!delta.amount) continue;
    add(delta.amount, 1, delta.direction);
  }
  for (const [currency, value] of values) {
    if (value.count === 0 && !isZeroExact(value.amount))
      throw new Error(`Spending summary delta left a non-zero ${currency} amount without records.`);
  }
  return Object.freeze(readTotals(values).map(({ currency, coefficient, scale, count }) =>
    Object.freeze({ currency, coefficient, scale, count })));
}

/** Apply a worker-validated pair action to a matching compact summary. */
export function applySpendingSummaryDelta(
  summary: SpendingPurchaseReportSummaryDto,
  baseKnowledgeAt: number,
  knowledgeAt: number,
  delta: SpendingPageActionResult["summaryDelta"],
): SpendingPurchaseReportSummaryDto {
  if (!Number.isSafeInteger(baseKnowledgeAt) || !Number.isSafeInteger(knowledgeAt) || knowledgeAt < baseKnowledgeAt)
    throw new TypeError("Spending summary delta version is invalid.");
  if (delta.before.some((line) => !SPENDING_SUMMARY_DATE.test(line.date)) ||
      delta.after.some((line) => !SPENDING_SUMMARY_DATE.test(line.date)))
    throw new TypeError("Spending summary delta date is invalid.");

  const allMoneyDeltas = [
    ...delta.before.map((line) => ({ amount: line.amount, direction: -1 as const })),
    ...delta.after.map((line) => ({ amount: line.amount, direction: 1 as const })),
  ];
  const totalsByCurrency = summaryMoneyAfter(summary.totalsByCurrency, allMoneyDeltas);

  const rowDeltaByDate = new Map<string, number>();
  const moneyDeltaByDate = new Map<string, typeof allMoneyDeltas>();
  const addRows = (lines: readonly SpendingSummaryDeltaLine[], direction: 1 | -1) => {
    for (const line of lines) {
      rowDeltaByDate.set(line.date, (rowDeltaByDate.get(line.date) ?? 0) + direction);
      const existing = moneyDeltaByDate.get(line.date) ?? [];
      existing.push({ amount: line.amount, direction });
      moneyDeltaByDate.set(line.date, existing);
    }
  };
  addRows(delta.before, -1);
  addRows(delta.after, 1);

  const dayByDate = new Map(summary.dayTotals.map((day) => [day.date, day]));
  const touchedDates = new Set([...rowDeltaByDate.keys()]);
  for (const date of touchedDates) {
    const prior = dayByDate.get(date);
    const rowCount = (prior?.recordCount ?? 0) + (rowDeltaByDate.get(date) ?? 0);
    if (rowCount < 0) throw new Error("Spending summary delta removed a missing date.");
    if (rowCount === 0) {
      dayByDate.delete(date);
      continue;
    }
    dayByDate.set(date, Object.freeze({
      month: date.slice(0, 7),
      date,
      recordCount: rowCount,
      totalsByCurrency: summaryMoneyAfter(prior?.totalsByCurrency ?? [], moneyDeltaByDate.get(date) ?? []),
    }));
  }
  const dayTotals = Object.freeze([...dayByDate.values()].sort((left, right) => left.date.localeCompare(right.date)));

  const rowDeltaByMonth = new Map<string, number>();
  const moneyDeltaByMonth = new Map<string, typeof allMoneyDeltas>();
  const addMonths = (lines: readonly SpendingSummaryDeltaLine[], direction: 1 | -1) => {
    for (const line of lines) {
      const month = line.date.slice(0, 7);
      rowDeltaByMonth.set(month, (rowDeltaByMonth.get(month) ?? 0) + direction);
      const existing = moneyDeltaByMonth.get(month) ?? [];
      existing.push({ amount: line.amount, direction });
      moneyDeltaByMonth.set(month, existing);
    }
  };
  addMonths(delta.before, -1);
  addMonths(delta.after, 1);
  const oldMonths = new Map(summary.monthTotals.map((month) => [month.month, month]));
  const months = new Set([...oldMonths.keys(), ...rowDeltaByMonth.keys()]);
  const monthTotals = Object.freeze([...months].sort().flatMap((month) => {
    const prior = oldMonths.get(month);
    const recordCount = (prior?.recordCount ?? 0) + (rowDeltaByMonth.get(month) ?? 0);
    if (recordCount < 0) throw new Error("Spending summary delta removed a missing month.");
    if (recordCount === 0) return [];
    return [Object.freeze({
      month,
      recordCount,
      activeDayCount: dayTotals.filter((day) => day.month === month).length,
      pendingCandidateCount: null,
      totalsByCurrency: summaryMoneyAfter(prior?.totalsByCurrency ?? [], moneyDeltaByMonth.get(month) ?? []),
    })];
  }));
  const recordCount = summary.recordCount + delta.after.length - delta.before.length;
  if (recordCount < 0) throw new Error("Spending summary delta removed missing records.");
  return Object.freeze({
    ...summary,
    recordCount,
    candidateCount: null,
    pendingCandidateCount: null,
    candidateState: "unloaded",
    currencies: Object.freeze(totalsByCurrency.map((amount) => amount.currency)),
    totalsByCurrency,
    monthTotals,
    dayTotals,
    categoryTotalsByMonth: categoryTotalsAfter(summary.categoryTotalsByMonth, [
      ...delta.before.map((line) => ({ line, direction: -1 as const })),
      ...delta.after.map((line) => ({ line, direction: 1 as const })),
    ]),
  });
}

/**
 * Reconcile the action result with a live summary that may arrive first.
 * The live row is already authoritative at the action version, so only its
 * affected records should be merged; a newer live version wins outright.
 */
export function reconcileSpendingPageActionSummary(
  summary: SpendingPurchaseReportSummaryDto,
  currentKnowledgeAt: number,
  result: SpendingPageActionResult,
): Readonly<{
  state: "apply-delta" | "already-current" | "newer-live-version";
  summary: SpendingPurchaseReportSummaryDto;
}> {
  if (!Number.isSafeInteger(currentKnowledgeAt) || currentKnowledgeAt < 0)
    throw new TypeError("Spending summary version is invalid.");
  if (currentKnowledgeAt > result.knowledgeAt)
    return Object.freeze({ state: "newer-live-version", summary });
  if (currentKnowledgeAt === result.knowledgeAt)
    return Object.freeze({ state: "already-current", summary });
  if (currentKnowledgeAt !== result.baseKnowledgeAt)
    throw new Error("Spending summary does not match the action result base version.");
  return Object.freeze({
    state: "apply-delta",
    summary: applySpendingSummaryDelta(summary, result.baseKnowledgeAt, result.knowledgeAt, result.summaryDelta),
  });
}

/** The canonical view a page action's summary implies, so the worker and the renderer publish the same one. */
export function spendingCanonicalAt(
  canonical: CanonicalSpendingView,
  summary: SpendingPurchaseReportSummaryDto,
  knowledgeAt: number,
): CanonicalSpendingView {
  return Object.freeze({
    ...canonical,
    availability: summary.recordCount > 0 ? "available" : "empty",
    knowledgePoint: knowledgeAt,
    totalsByCurrency: summary.totalsByCurrency.map((amount) => ({
      currency: amount.currency,
      value: exactToNumber(amount),
      exact: { coefficient: amount.coefficient, scale: amount.scale },
    })),
    totalStatus: "complete",
  });
}

/** A pairing request is bound to the report version shown in the renderer. */
export type SpendingPairingCandidatesInput = Readonly<{
  invoiceIdentityId: string;
  dataVersion: number;
  /** Revalidate a selected transaction across the complete ranking. */
  selectedTransactionId?: string;
  offset?: number;
  limit?: number;
}>;

/** Prepare the worker-owned pairing index for the report snapshot shown in the renderer. */
export type SpendingPairingPrewarmInput = Readonly<{
  dataVersion: number;
}>;

export type SpendingPairingPrewarmResult =
  | Readonly<{
      status: "ready";
      dataVersion: number;
      reused: boolean;
    }>
  | Readonly<{
      status: "stale";
      dataVersion: number;
      requestedVersion: number;
    }>;

export type SpendingPairingCandidatesResult = Readonly<{
  dataVersion: number;
  candidates: readonly SpendingPairingCandidateView[];
  /** Present only when selectedTransactionId was requested. */
  selectedCandidate?: SpendingPairingCandidateView | null;
  totalCandidateCount: number;
  nextOffset: number | null;
}>;

export type SpendingItemDto = {
  itemKey: string;
  sequence: number | null;
  quantity: number | null;
  unitPrice: number | null;
  /** Null means the provider returned the item without an amount. */
  paidAmount: number | null;
  productName: string | null;
  /** Provider completeness is visible until a future enrichment classifies it. */
  completeness?: "complete" | "incomplete";
};

export type SpendingInvoiceDto = {
  invoiceKey: string;
  invoiceId: string;
  issuedAt: number;
  amount: number;
  sellerBusinessAccountNumber: string | null;
  sellerName: string | null;
  sellerAddr: string | null;
  items: SpendingItemDto[];
  /** Current canonical invoice revision kind, for source-aware UI diagnostics. */
  revisionKind?: "issued" | "revised";
};

/** Active desktop Spending payload. */
export type SpendingPageDto = {
  canonical: CanonicalSpendingView;
  /** Purchase-basis canonical report used by the active Spending page. */
  purchaseReport: SpendingPurchaseReportDto;
  /** Compatibility projection kept for existing non-product fixtures. */
  invoices: readonly SpendingInvoiceDto[];
};

export type CanonicalSpendingAmountDto = {
  currency: string;
  value: number;
  exact: {
    coefficient: string;
    scale: number;
  };
};

export type CanonicalSpendingCategoryDto = {
  mode: "single" | "allocated" | "absent";
  code: string | null;
  taxonomyId: string | null;
  taxonomyVersion: string | null;
  labels: {
    en: string;
    zhHant: string;
  } | null;
  components: readonly {
    code: string;
    taxonomyId: string;
    taxonomyVersion: string;
    labels: {
      en: string;
      zhHant: string;
    } | null;
    amount: CanonicalSpendingAmountDto;
  }[];
};

export type CanonicalSpendingRecordDto = {
  transactionId: string;
  accountId: string;
  accountNumber: string | null;
  sourceConnectionKey: string;
  integrationNamespace: string;
  stream: string;
  date: string;
  /** Effective purchase date basis exposed for source-aware Spending UI. */
  dateBasis: "consume-date" | "posting-date-fallback" | "effective-date";
  consumeDate: string | null;
  postingDate: string | null;
  description: string | null;
  amount: CanonicalSpendingAmountDto;
  kind: string | null;
  category: CanonicalSpendingCategoryDto;
  display: {
    label: string | null;
    status: "supported" | "fallback" | "absent";
    origin: string | null;
    kind: string | null;
  };
  tags: readonly {
    id: string;
    label: string;
  }[];
  inclusion: "included" | "excluded" | "eligibility-gap";
  eligibilityGap: string | null;
};

export type CanonicalSpendingView = {
  availability: "empty" | "available" | "unavailable";
  policy: {
    id: "gross-posted-outflow";
    version: "v1";
    name: "Gross posted outflow";
  };
  knowledgePoint: number;
  selectedMonth: string | null;
  selectedCategory: string | null;
  transactions: readonly CanonicalSpendingRecordDto[];
  includedTransactions: readonly CanonicalSpendingRecordDto[];
  totalsByCurrency: readonly CanonicalSpendingAmountDto[];
  categoryTotalsByCurrency: readonly {
    categoryCode: string;
    taxonomyId: string;
    taxonomyVersion: string;
    labels: {
      en: string;
      zhHant: string;
    } | null;
    currency: string;
    amount: CanonicalSpendingAmountDto;
    count: number;
  }[];
  unclassifiedByCurrency: readonly CanonicalSpendingAmountDto[];
  classificationCoverage: {
    includedCount: number;
    classifiedCount: number;
    unclassifiedCount: number;
    includedAmountByCurrency: readonly CanonicalSpendingAmountDto[];
    classifiedAmountByCurrency: readonly CanonicalSpendingAmountDto[];
    unclassifiedAmountByCurrency: readonly CanonicalSpendingAmountDto[];
  };
  reportEligibility: {
    status: "complete" | "incomplete";
    gapCount: number;
    gapAmountByCurrency: readonly CanonicalSpendingAmountDto[];
  };
  totalStatus: "complete" | "incomplete";
};

const taipeiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function taipeiDateKey(unixSeconds: number): string {
  const parts = Object.fromEntries(
    taipeiDateFormatter.formatToParts(new Date(unixSeconds * 1000))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
