import {
  SPENDING_CATEGORY_IDS,
  type SpendingCategory,
} from "./categories.ts";
import type { PurchaseReport } from "../../ledger/canonical/spending-purchase-report.ts";
import type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
import type { SpendingPurchaseReportView } from "./purchase-matching.ts";
export type { SpendingPairingCandidateView } from "./pairing-presentation.ts";
export type { SpendingPurchaseActionResult } from "./purchase-report-patch.ts";

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
}>;

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

/** Preserve a user's month/day selection when a compact summary version changes. */
export function preserveSpendingMonthSelection(
  previousSummary: Pick<SpendingPurchaseReportSummaryDto, "monthTotals"> | undefined,
  nextSummary: Pick<SpendingPurchaseReportSummaryDto, "monthTotals"> | undefined,
  selectedMonth: string | null,
  selectedDay: string | null,
): Readonly<{ selectedMonth: string | null; selectedDay: string | null }> {
  if (!previousSummary || !nextSummary) return { selectedMonth: null, selectedDay: null };

  if (selectedMonth !== null) {
    if (!nextSummary.monthTotals.some((month) => month.month === selectedMonth))
      return { selectedMonth: null, selectedDay: null };
    return {
      selectedMonth,
      selectedDay: selectedDay?.startsWith(`${selectedMonth}-`) ? selectedDay : null,
    };
  }

  const nextActiveMonth = nextSummary.monthTotals.at(-1)?.month ?? null;
  return {
    selectedMonth: null,
    selectedDay: selectedDay && nextActiveMonth && selectedDay.startsWith(`${nextActiveMonth}-`)
      ? selectedDay
      : null,
  };
}

export type SpendingRecordPageRequest = Readonly<{
  knowledgeAt: number;
  month?: string | null;
  day?: string | null;
  cursor?: string | null;
  limit?: number;
}>;

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
  records: readonly SpendingPurchaseReportView["records"][number][];
  nextCursor: string | null;
}>;

export type SpendingCandidatePageRequest = Readonly<{
  knowledgeAt: number;
  /** The selected calendar month; dashboard pairing pages are month-scoped. */
  month: string;
  offset?: number;
  limit?: number;
}>;

export type SpendingCandidatePageItem = Readonly<{
  candidate: SpendingPurchaseReportView["candidates"][number];
  invoiceRecord: SpendingPurchaseReportView["records"][number] | null;
  paymentRecord: SpendingPurchaseReportView["records"][number] | null;
}>;

export type SpendingCandidatePageDto = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  month: string;
  items: readonly SpendingCandidatePageItem[];
  /** Candidate count for this month only. */
  totalCandidateCount: number;
  nextOffset: number | null;
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
}>;

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
    .flatMap((line) => line.amount ? [line.amount.scale] : []);
  const existingScales = [
    ...summary.totalsByCurrency,
    ...summary.monthTotals.flatMap((month) => month.totalsByCurrency),
    ...summary.dayTotals.flatMap((day) => day.totalsByCurrency),
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
  category: SpendingCategory;
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

export type SpendingState = "included" | "excluded" | "pending";
export type SpendingSource = "invoice" | "account";
export const SPENDING_REASONS = [
  "direct_purchase",
  "credit_card_payment",
  "loan_payment",
  "internal_transfer",
  "invoice_duplicate",
  "ambiguous_transfer",
  "cash_withdrawal",
  "unclassified",
] as const;
export type SpendingReason = typeof SPENDING_REASONS[number];

export type SpendingAccountTransactionInput = {
  statementRowId: string;
  bank: string;
  accountNumber: string | null;
  currency: string;
  date: string;
  time: string | null;
  description: string | null;
  note: string | null;
  amount: number;
};

export type SpendingCardPaymentInput = {
  date: string;
  amount: number;
};

export type SpendingOverrideDto = {
  statementRowId: string;
  state: SpendingState;
  category: SpendingCategory | null;
  automaticState: SpendingState;
  automaticReason: SpendingReason | null;
  updatedAt: string;
};

export type SpendingAccountRecord = {
  key: string;
  source: "account";
  statementRowId: string;
  state: SpendingState;
  automaticState: SpendingState;
  automaticReason: SpendingReason;
  automaticCategory: SpendingCategory;
  duplicateInvoiceKey?: string;
  manual: boolean;
  date: string;
  time: string | null;
  label: string;
  bank: string;
  accountNumber: string | null;
  currency: string;
  note: string | null;
  destinationBankCode: string | null;
  destinationAccountNumber: string | null;
  amount: number;
  category: SpendingCategory;
};

export type SpendingTransferDestination = {
  bankCode: string;
  accountNumber: string;
};

export function parseTransferDestination(note: string | null): SpendingTransferDestination | null {
  const token = note?.trim().split(/\s+/u)[0];
  if (!token || !/^\d{16,17}$/u.test(token)) return null;
  return { bankCode: token.slice(0, 3), accountNumber: token.slice(3) };
}

export type SpendingInvoiceRecord = {
  key: string;
  source: "invoice";
  state: "included";
  date: string;
  label: string;
  amount: number;
  categories: SpendingCategory[];
  invoiceKey: string;
  accountStatementRowIds: string[];
};

export type SpendingDisplayRecord = SpendingInvoiceRecord | SpendingAccountRecord;

export type SpendingCategoryAmounts = Record<SpendingCategory, number>;
export type SpendingSourceAmounts = {
  invoice: SpendingCategoryAmounts;
  account: SpendingCategoryAmounts;
};
export type MonthlySpendingRow = SpendingSourceAmounts & {
  month: string;
  total: number;
  pendingAccount: SpendingCategoryAmounts;
};
export type DailySpendingRow = SpendingSourceAmounts & {
  date: string;
  total: number;
};
export type SpendingMonthSummary = {
  total: number;
  invoiceCount: number;
  accountCount: number;
};
export type SpendingDateGroup = {
  date: string;
  records: SpendingDisplayRecord[];
  includedTotal: number;
  excludedCount: number;
  pendingCount: number;
};
export type SpendingModel = {
  canonical?: CanonicalSpendingView;
  months: string[];
  monthlyRows: MonthlySpendingRow[];
  selectedMonth: string | null;
  selectedCategory?: SpendingCategory;
  selectedMonthSummary: SpendingMonthSummary;
  dailyRows: DailySpendingRow[];
  presentCategories: SpendingCategory[];
  invoices: SpendingInvoiceDto[];
  accountRecords: SpendingAccountRecord[];
  excludedAccountRecords: SpendingAccountRecord[];
  pendingAccountRecords: SpendingAccountRecord[];
  recordsByDate: SpendingDateGroup[];
};

/** Active desktop Spending payload. Legacy model fields stay available only to
 * the compatibility model builder and are not emitted by the product loader. */
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

export type BuildSpendingModelInput = {
  invoices: readonly SpendingInvoiceDto[];
  accountTransactions?: readonly SpendingAccountTransactionInput[];
  counterpartDeposits?: readonly SpendingAccountTransactionInput[];
  cardPayments?: readonly SpendingCardPaymentInput[];
  overrides?: readonly SpendingOverrideDto[];
  selectedMonth?: string;
  selectedCategory?: SpendingCategory;
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

function categoryAmounts(): SpendingCategoryAmounts {
  return {
    food: 0,
    daily: 0,
    transport: 0,
    shopping: 0,
    home: 0,
    leisure: 0,
    other: 0,
  };
}

function addCategoryAmounts(
  target: SpendingCategoryAmounts,
  source: SpendingCategoryAmounts,
) {
  for (const category of SPENDING_CATEGORY_IDS) target[category] += source[category];
}

function sourceAmounts(): SpendingSourceAmounts {
  return { invoice: categoryAmounts(), account: categoryAmounts() };
}

function normalizedText(value: string | null): string {
  return (value ?? "")
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xFEE0)
    )
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function nearbyDate(left: string, right: string): boolean {
  return Math.abs(Date.parse(left) - Date.parse(right)) <= 2 * 86_400_000;
}

function matchingInvoice(
  row: SpendingAccountTransactionInput,
  invoices: readonly SpendingInvoiceDto[],
): SpendingInvoiceDto | undefined {
  const text = normalizedText(`${row.description ?? ""}${row.note ?? ""}`);
  return invoices.find((invoice) => {
    const seller = normalizedText(invoice.sellerName);
    return invoice.amount === row.amount && taipeiDateKey(invoice.issuedAt) === row.date &&
      text.length > 0 && seller.length > 0 && (text.includes(seller) || seller.includes(text));
  });
}

function automaticAccountDecision(
  row: SpendingAccountTransactionInput,
  deposits: readonly SpendingAccountTransactionInput[],
  invoices: readonly SpendingInvoiceDto[],
  cardPayments: readonly SpendingCardPaymentInput[],
): { state: SpendingState; reason: SpendingReason; category: SpendingCategory; invoiceKey?: string } {
  const text = normalizedText(`${row.description ?? ""}${row.note ?? ""}`);
  const sourceAccountNumber = normalizedText(row.accountNumber);
  const excluded = (reason: SpendingReason, category: SpendingCategory = "other") =>
    ({ state: "excluded" as const, reason, category });

  if (/(放款繳款|貸款繳款|繳貸款|貸款扣款)/u.test(text)) return excluded("loan_payment");
  if (/(信用卡款|信用卡費|繳信用卡)/u.test(text) || cardPayments.some(
    (payment) => payment.amount === row.amount && nearbyDate(payment.date, row.date),
  )) return excluded("credit_card_payment");
  if (text.includes("自轉") || sourceAccountNumber.length > 0 && deposits.some((deposit) => {
    const accountNumber = normalizedText(deposit.accountNumber);
    return accountNumber.length > 0 && accountNumber !== sourceAccountNumber &&
      text.includes(accountNumber);
  })) return excluded("internal_transfer");
  if (sourceAccountNumber.length > 0 && deposits.some((deposit) => {
    const accountNumber = normalizedText(deposit.accountNumber);
    return accountNumber.length > 0 && accountNumber !== sourceAccountNumber &&
      deposit.currency === row.currency &&
      deposit.amount === row.amount && nearbyDate(deposit.date, row.date);
  })) return excluded("internal_transfer");

  const invoice = matchingInvoice(row, invoices);
  if (invoice) return {
    ...excluded("invoice_duplicate", invoice.items[0]?.category ?? "other"),
    invoiceKey: invoice.invoiceKey,
  };
  if (/(簽帳消費|金融卡消費|簽帳購物)/u.test(text)) {
    return { state: "included", reason: "direct_purchase", category: "other" };
  }
  if (/(提款|現金提領)/u.test(text)) {
    return { state: "pending", reason: "cash_withdrawal", category: "other" };
  }
  if (/(轉帳|轉出|匯款)/u.test(text)) {
    return { state: "pending", reason: "ambiguous_transfer", category: "other" };
  }
  return { state: "pending", reason: "unclassified", category: "other" };
}

export function buildSpendingModel(
  input: BuildSpendingModelInput,
): SpendingModel {
  const {
    invoices,
    accountTransactions = [],
    counterpartDeposits = [],
    cardPayments = [],
    overrides = [],
    selectedMonth,
    selectedCategory,
  } = input;
  const monthly = new Map<string, MonthlySpendingRow>();
  const derived: Array<{
    invoice: SpendingInvoiceDto;
    month: string;
    date: string;
    amounts: SpendingCategoryAmounts;
    categories: Set<SpendingCategory>;
  }> = [];

  for (const invoice of invoices) {
    const date = taipeiDateKey(invoice.issuedAt);
    const month = date.slice(0, 7);
    const amounts = categoryAmounts();
    const categories = new Set<SpendingCategory>();
    let itemTotal = 0;

    for (const item of invoice.items) {
      if (item.paidAmount !== null) {
        amounts[item.category] += item.paidAmount;
        itemTotal += item.paidAmount;
      }
      categories.add(item.category);
    }

    const reconciliationCategory = invoice.items[0]?.category ?? "other";
    amounts[reconciliationCategory] += invoice.amount - itemTotal;
    categories.add(reconciliationCategory);

    const row = monthly.get(month) ?? {
      month,
      total: 0,
      ...sourceAmounts(),
      pendingAccount: categoryAmounts(),
    };
    row.total += invoice.amount;
    addCategoryAmounts(row.invoice, amounts);
    monthly.set(month, row);
    derived.push({ invoice, month, date, amounts, categories });
  }

  const overrideById = new Map(overrides.map((override) => [override.statementRowId, override]));
  const duplicateInvoiceRows = new Map<string, string[]>();
  const accountRecords = accountTransactions.map((row): SpendingAccountRecord => {
    const automatic = automaticAccountDecision(row, counterpartDeposits, invoices, cardPayments);
    const override = overrideById.get(row.statementRowId);
    const destination = parseTransferDestination(row.note);
    const record: SpendingAccountRecord = {
      key: `account:${row.statementRowId}`,
      source: "account",
      statementRowId: row.statementRowId,
      state: override?.state ?? automatic.state,
      automaticState: automatic.state,
      automaticReason: automatic.reason,
      automaticCategory: automatic.category,
      duplicateInvoiceKey: automatic.invoiceKey,
      manual: override !== undefined,
      date: row.date,
      time: row.time,
      label: row.description ?? row.note ?? row.bank,
      bank: row.bank,
      accountNumber: row.accountNumber,
      currency: row.currency,
      note: row.note,
      destinationBankCode: destination?.bankCode ?? null,
      destinationAccountNumber: destination?.accountNumber ?? null,
      amount: row.amount,
      category: override?.category ?? automatic.category,
    };
    if (automatic.invoiceKey && record.state === "excluded") {
      const ids = duplicateInvoiceRows.get(automatic.invoiceKey) ?? [];
      ids.push(row.statementRowId);
      duplicateInvoiceRows.set(automatic.invoiceKey, ids);
    }
    const month = row.date.slice(0, 7);
    const monthlyRow = monthly.get(month) ?? {
      month,
      total: 0,
      ...sourceAmounts(),
      pendingAccount: categoryAmounts(),
    };
    if (record.state === "included") {
      monthlyRow.total += record.amount;
      monthlyRow.account[record.category] += record.amount;
    } else if (record.state === "pending") {
      monthlyRow.pendingAccount[record.category] += record.amount;
    }
    monthly.set(month, monthlyRow);
    return record;
  });

  const months = [...monthly.keys()].sort();
  const activeMonth = selectedMonth ?? months.at(-1) ?? null;
  const daily = new Map<string, DailySpendingRow>();
  const present = new Set<SpendingCategory>();
  const filteredInvoices: SpendingInvoiceDto[] = [];
  const selectedMonthSummary = { total: 0, invoiceCount: 0, accountCount: 0 };
  const displayRecords: SpendingDisplayRecord[] = [];

  for (const entry of derived) {
    if (entry.month !== activeMonth) continue;
    selectedMonthSummary.total += entry.invoice.amount;
    selectedMonthSummary.invoiceCount += 1;
    for (const category of entry.categories) present.add(category);
    if (!selectedCategory || entry.categories.has(selectedCategory)) {
      filteredInvoices.push(entry.invoice);
      displayRecords.push({
        key: `invoice:${entry.invoice.invoiceKey}`,
        source: "invoice",
        state: "included",
        date: entry.date,
        label: entry.invoice.sellerName ?? entry.invoice.invoiceId,
        amount: entry.invoice.amount,
        categories: [...entry.categories],
        invoiceKey: entry.invoice.invoiceKey,
        accountStatementRowIds: duplicateInvoiceRows.get(entry.invoice.invoiceKey) ?? [],
      });
    }

    const row = daily.get(entry.date) ?? {
      date: entry.date,
      total: 0,
      ...sourceAmounts(),
    };
    row.total += entry.invoice.amount;
    addCategoryAmounts(row.invoice, entry.amounts);
    daily.set(entry.date, row);
  }

  const selectedAccountRecords = accountRecords.filter((record) =>
    record.date.slice(0, 7) === activeMonth
  );
  for (const record of selectedAccountRecords) {
    if (record.state === "included") {
      selectedMonthSummary.total += record.amount;
      selectedMonthSummary.accountCount += 1;
      present.add(record.category);
      const row = daily.get(record.date) ?? { date: record.date, total: 0, ...sourceAmounts() };
      row.total += record.amount;
      row.account[record.category] += record.amount;
      daily.set(record.date, row);
    }
    if (!(record.automaticReason === "invoice_duplicate" && record.state === "excluded") &&
      (!selectedCategory || record.category === selectedCategory)) {
      displayRecords.push(record);
    }
  }

  const recordsByDate = [...Map.groupBy(displayRecords, (record) => record.date)]
    .map(([date, records]) => ({
      date,
      records,
      includedTotal: records.reduce(
        (total, record) => total + (record.state === "included" ? record.amount : 0),
        0,
      ),
      excludedCount: records.filter((record) => record.state === "excluded").length,
      pendingCount: records.filter((record) => record.state === "pending").length,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));

  return {
    months,
    monthlyRows: [...monthly.values()].sort((left, right) => left.month.localeCompare(right.month)),
    selectedMonth: activeMonth,
    selectedCategory,
    selectedMonthSummary,
    dailyRows: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    presentCategories: SPENDING_CATEGORY_IDS.filter((category) => present.has(category)),
    invoices: filteredInvoices,
    accountRecords,
    excludedAccountRecords: selectedAccountRecords.filter((record) => record.state === "excluded"),
    pendingAccountRecords: selectedAccountRecords.filter((record) => record.state === "pending"),
    recordsByDate,
  };
}

export function applySpendingAccountOverride(
  model: SpendingModel,
  statementRowId: string,
  state: SpendingState | null,
  category: SpendingCategory | null = null,
): SpendingModel {
  const previous = model.accountRecords.find((record) => record.statementRowId === statementRowId);
  if (!previous) return model;

  const record: SpendingAccountRecord = {
    ...previous,
    state: state ?? previous.automaticState,
    category: state === null ? previous.automaticCategory : category ?? previous.category,
    manual: state !== null,
  };
  const accountRecords = model.accountRecords.map((candidate) =>
    candidate.statementRowId === statementRowId ? record : candidate
  );
  const month = record.date.slice(0, 7);
  const oldAmount = previous.state === "included" ? previous.amount : 0;
  const newAmount = record.state === "included" ? record.amount : 0;
  const oldPendingAmount = previous.state === "pending" ? previous.amount : 0;
  const newPendingAmount = record.state === "pending" ? record.amount : 0;
  const adjust = <T extends SpendingSourceAmounts & { total: number }>(row: T): T => {
    const account = { ...row.account };
    if (oldAmount) account[previous.category] -= oldAmount;
    if (newAmount) account[record.category] += newAmount;
    return { ...row, total: row.total - oldAmount + newAmount, account };
  };
  const monthlyRows = model.monthlyRows.map((row) => {
    if (row.month !== month) return row;
    const pendingAccount = { ...row.pendingAccount };
    if (oldPendingAmount) pendingAccount[previous.category] -= oldPendingAmount;
    if (newPendingAmount) pendingAccount[record.category] += newPendingAmount;
    return { ...adjust(row), pendingAccount };
  });
  const dailyRows = (
    model.dailyRows.some((row) => row.date === record.date) || !newAmount
      ? model.dailyRows
      : [...model.dailyRows, { date: record.date, total: 0, ...sourceAmounts() }]
  ).map((row) => row.date === record.date ? adjust(row) : row)
    .filter((row) => row.total !== 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  const selectedAccountRecords = accountRecords.filter((candidate) =>
    candidate.date.slice(0, 7) === model.selectedMonth
  );
  const invoiceRecords = model.recordsByDate.flatMap((group) => group.records)
    .filter((candidate): candidate is SpendingInvoiceRecord => candidate.source === "invoice")
    .map((invoice) => ({
      ...invoice,
      accountStatementRowIds: selectedAccountRecords
        .filter((candidate) =>
          candidate.duplicateInvoiceKey === invoice.invoiceKey && candidate.state === "excluded"
        )
        .map((candidate) => candidate.statementRowId),
    }));
  const displayRecords: SpendingDisplayRecord[] = [
    ...invoiceRecords,
    ...selectedAccountRecords.filter((candidate) =>
      !(candidate.duplicateInvoiceKey && candidate.state === "excluded") &&
      (!model.selectedCategory || candidate.category === model.selectedCategory)
    ),
  ];
  const recordsByDate = [...Map.groupBy(displayRecords, (candidate) => candidate.date)]
    .map(([date, records]) => ({
      date,
      records,
      includedTotal: records.reduce(
        (total, candidate) => total + (candidate.state === "included" ? candidate.amount : 0),
        0,
      ),
      excludedCount: records.filter((candidate) => candidate.state === "excluded").length,
      pendingCount: records.filter((candidate) => candidate.state === "pending").length,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));

  return {
    ...model,
    monthlyRows,
    selectedMonthSummary: model.selectedMonth === month
      ? {
          ...model.selectedMonthSummary,
          total: model.selectedMonthSummary.total - oldAmount + newAmount,
          accountCount: model.selectedMonthSummary.accountCount - Number(Boolean(oldAmount)) +
            Number(Boolean(newAmount)),
        }
      : model.selectedMonthSummary,
    dailyRows,
    accountRecords,
    excludedAccountRecords: selectedAccountRecords.filter((candidate) => candidate.state === "excluded"),
    pendingAccountRecords: selectedAccountRecords.filter((candidate) => candidate.state === "pending"),
    recordsByDate,
  };
}
