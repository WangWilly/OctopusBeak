import type { PurchaseReport } from "../../ledger/canonical/spending-purchase-report.ts";
import type { PurchaseCategory } from "./purchase-category-view.ts";
import type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
import type { SpendingPurchaseReportView } from "./purchase-matching.ts";
import type {
  SpendingCandidateReasons,
  SpendingCandidateStrength,
} from "../../ledger/canonical/spending-match-strength.ts";
import type { MerchantIdentity } from "../../ledger/canonical/spending-month-insights.ts";
export type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
export type { SpendingPurchaseActionResult } from "./purchase-report-patch.ts";
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

export type SpendingMerchantStatsRequest = Readonly<{ knowledgeAt: number; purchaseId: string }>;

/** Exact merchant identity: seller tax ID for invoice-backed purchases, normalized bank text otherwise. */
export type SpendingMerchantIdentity = MerchantIdentity;

/** 本月同商家: purchases in the given purchase's month with the same merchant identity. */
export type SpendingMerchantStatsDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  purchaseId: string;
  month: string;
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

function categoryTotalsAtScale(
  rows: readonly SpendingCategoryMonthTotal[],
  targetScale: number,
  lines: readonly Readonly<{ line: SpendingSummaryDeltaLine; direction: 1 | -1 }>[],
): readonly SpendingCategoryMonthTotal[] {
  const values = new Map<string, { month: string; currency: string; categoryCode: string | null; coefficient: bigint; count: number }>();
  const add = (month: string, currency: string, categoryCode: string | null, coefficient: string, scale: number, count: number, direction: 1 | -1) => {
    const key = `${month}|${currency}|${categoryCode ?? ""}`;
    const current = values.get(key) ?? { month, currency, categoryCode, coefficient: 0n, count: 0 };
    current.coefficient += BigInt(direction) * BigInt(coefficient) * summaryPowerOfTen(targetScale - scale);
    current.count += direction * count;
    if (current.count < 0) throw new Error("Spending summary delta removed a missing category amount.");
    values.set(key, current);
  };
  for (const row of rows) add(row.month, row.currency, row.categoryCode, row.coefficient, row.scale, row.count, 1);
  for (const { line, direction } of lines) {
    if (!line.amount) continue;
    const month = line.date.slice(0, 7);
    if (line.category.mode === "split") {
      for (const component of line.category.components)
        add(month, component.amount.currency, component.categoryCode, component.amount.coefficient, component.amount.scale, 1, direction);
      continue;
    }
    add(month, line.amount.currency, line.category.mode === "single" ? line.category.categoryCode : null, line.amount.coefficient, line.amount.scale, 1, direction);
  }
  return Object.freeze([...values.values()]
    .filter((value) => value.count > 0)
    .sort((left, right) => left.month.localeCompare(right.month) || left.currency.localeCompare(right.currency) || (left.categoryCode ?? "").localeCompare(right.categoryCode ?? ""))
    .map((value) => Object.freeze({ month: value.month, currency: value.currency, categoryCode: value.categoryCode, coefficient: value.coefficient.toString(), scale: targetScale, count: value.count })));
}

const SPENDING_SUMMARY_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function summaryPowerOfTen(scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 1000)
    throw new TypeError("Spending summary scale is invalid.");
  return 10n ** BigInt(scale);
}

function summaryMoneyAtScale(
  rows: readonly Readonly<{ currency: string; coefficient: string; scale: number; count: number }>[],
  targetScale: number,
  deltas: readonly Readonly<{ amount: SpendingSummaryDeltaLine["amount"]; direction: 1 | -1 }>[],
) {
  const values = new Map<string, { coefficient: bigint; count: number }>();
  const add = (currency: string, coefficient: string, scale: number, count: number, direction: 1 | -1) => {
    if (!currency || !/^-?\d+$/u.test(coefficient) || !Number.isSafeInteger(count) || count < 0)
      throw new TypeError("Spending summary amount is invalid.");
    const aligned = BigInt(coefficient) * summaryPowerOfTen(targetScale - scale);
    const current = values.get(currency) ?? { coefficient: 0n, count: 0 };
    current.coefficient += BigInt(direction) * aligned;
    current.count += direction * count;
    if (current.count < 0) throw new Error("Spending summary delta removed a missing amount.");
    values.set(currency, current);
  };

  for (const row of rows) add(row.currency, row.coefficient, row.scale, row.count, 1);
  for (const delta of deltas) {
    if (!delta.amount) continue;
    add(delta.amount.currency, delta.amount.coefficient, delta.amount.scale, 1, delta.direction);
  }
  for (const [currency, value] of values) {
    if (value.count === 0 && value.coefficient !== 0n)
      throw new Error(`Spending summary delta left a non-zero ${currency} amount without records.`);
  }
  return Object.freeze([...values.entries()]
    .filter(([, value]) => value.count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => {
      return Object.freeze({ currency, coefficient: value.coefficient.toString(), scale: targetScale, count: value.count });
    }));
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

  const deltaAmounts = [...delta.before, ...delta.after]
    .flatMap((line) => [
      ...(line.amount ? [line.amount.scale] : []),
      ...(line.category.mode === "split" ? line.category.components.map((component) => component.amount.scale) : []),
    ]);
  const existingScales = [
    ...summary.totalsByCurrency,
    ...summary.monthTotals.flatMap((month) => month.totalsByCurrency),
    ...summary.dayTotals.flatMap((day) => day.totalsByCurrency),
    ...summary.categoryTotalsByMonth,
  ].map((amount) => amount.scale);
  const scale = Math.max(0, ...existingScales, ...deltaAmounts);
  const allMoneyDeltas = [
    ...delta.before.map((line) => ({ amount: line.amount, direction: -1 as const })),
    ...delta.after.map((line) => ({ amount: line.amount, direction: 1 as const })),
  ];
  const totalsByCurrency = summaryMoneyAtScale(summary.totalsByCurrency, scale, allMoneyDeltas);

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
      totalsByCurrency: summaryMoneyAtScale(
        prior?.totalsByCurrency ?? [],
        scale,
        moneyDeltaByDate.get(date) ?? [],
      ),
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
      totalsByCurrency: summaryMoneyAtScale(
        prior?.totalsByCurrency ?? [],
        scale,
        moneyDeltaByMonth.get(month) ?? [],
      ),
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
    categoryTotalsByMonth: categoryTotalsAtScale(summary.categoryTotalsByMonth, scale, [
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

export type SpendingCandidateActionInput = Readonly<{
  kind: "candidate";
  candidateId: string;
  /** Optional facts already visible in the current report; the writer validates them. */
  invoiceIdentityId?: string;
  transactionIdentityId?: string;
  dataVersion?: number;
  totalsByCurrency?: SpendingPurchaseReportDto["totalsByCurrency"];
  pairingReportContext?: SpendingPairingReportContext;
}>;

export type SpendingPairingReportContext = Readonly<{
  /** Index after removing the two standalone records, at the start of the link's date group. */
  recordInsertIndex: number;
  sameDatePurchaseIds: readonly string[];
  candidateIds: readonly string[];
  totalStatusAfter: SpendingPurchaseReportDto["totalStatus"];
  /** Candidate confirmation/denial needs the displayed rows for targeted patches. */
  candidateIndex?: number;
  actedCandidateId?: string;
  invoiceRecordIndex?: number;
  paymentRecordIndex?: number;
  invoiceRecord?: SpendingPurchaseReportView["records"][number];
  paymentRecord?: SpendingPurchaseReportView["records"][number];
}>;

/** Build compact patch placement from the report displayed at the action click. */
export function spendingPairingReportContext(
  report: SpendingPurchaseReportView,
  invoiceRecord: SpendingPurchaseReportView["records"][number],
  paymentRecord: SpendingPurchaseReportView["records"][number],
  actedCandidateId?: string,
): SpendingPairingReportContext {
  const remaining = report.records.filter((record) => record.purchaseId !== invoiceRecord.purchaseId && record.purchaseId !== paymentRecord.purchaseId);
  const date = invoiceRecord.occurrence.value;
  const first = remaining.findIndex((record) => record.occurrence.value >= date);
  const start = first < 0 ? remaining.length : first;
  const sameDatePurchaseIds: string[] = [];
  for (let index = start; index < remaining.length && remaining[index]!.occurrence.value === date; index += 1)
    sameDatePurchaseIds.push(remaining[index]!.purchaseId);
  const candidateIds = [...new Set([...invoiceRecord.candidateIds, ...paymentRecord.candidateIds])];
  const pendingLinked = candidateIds.filter((id) => id !== actedCandidateId);
  const totalStatusAfter = pendingLinked.length > 0 || remaining.some((record) => record.candidateIds.some((id) => id !== actedCandidateId))
    ? "includes-pending-confirmation" as const : "complete" as const;
  return {
    recordInsertIndex: start,
    sameDatePurchaseIds,
    candidateIds,
    totalStatusAfter,
    ...(actedCandidateId ? {
      candidateIndex: report.candidates.findIndex((candidate) => candidate.candidateId === actedCandidateId),
      actedCandidateId,
      invoiceRecordIndex: report.records.findIndex((record) => record.purchaseId === invoiceRecord.purchaseId),
      paymentRecordIndex: report.records.findIndex((record) => record.purchaseId === paymentRecord.purchaseId),
      invoiceRecord,
      paymentRecord,
    } : {}),
  };
}

export type SpendingConfirmActionInput = SpendingCandidateActionInput | Readonly<{
  kind: "direct";
  invoiceIdentityId: string;
  transactionIdentityId: string;
  /** Present for the non-blocking targeted-patch path; omitted by legacy callers. */
  dataVersion?: number;
  totalsByCurrency?: SpendingPurchaseReportDto["totalsByCurrency"];
  /** Optional compact renderer state used when the worker has no report cache. */
  pairingReportContext?: SpendingPairingReportContext;
}>;

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

export type SpendingLinkActionInput = Readonly<{
  invoiceId: string;
  transactionId: string;
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
