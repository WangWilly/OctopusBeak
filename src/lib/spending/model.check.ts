import assert from "node:assert/strict";
import {
  applySpendingSummaryDelta,
  preserveSpendingMonthSelection,
  reconcileSpendingPageActionSummary,
  type SpendingPurchaseReportSummaryDto,
} from "./model.ts";

const compactSummary = (months: readonly string[]): Pick<SpendingPurchaseReportSummaryDto, "monthTotals"> => ({
  monthTotals: months.map((month) => ({
    month,
    recordCount: 0,
    activeDayCount: 0,
    pendingCandidateCount: null,
    totalsByCurrency: [],
  })),
});

const exactSummary: SpendingPurchaseReportSummaryDto = {
  recordCount: 3,
  candidateCount: null,
  pendingCandidateCount: null,
  candidateState: "unloaded",
  currencies: ["TWD", "USD"],
  totalsByCurrency: [
    { currency: "TWD", coefficient: "12500", scale: 2, count: 2 },
    { currency: "USD", coefficient: "250", scale: 2, count: 1 },
  ],
  monthTotals: [
    { month: "2026-01", recordCount: 2, activeDayCount: 1, pendingCandidateCount: null, totalsByCurrency: [
      { currency: "TWD", coefficient: "10000", scale: 2, count: 1 },
      { currency: "USD", coefficient: "250", scale: 2, count: 1 },
    ] },
    { month: "2026-02", recordCount: 1, activeDayCount: 1, pendingCandidateCount: null, totalsByCurrency: [
      { currency: "TWD", coefficient: "2500", scale: 2, count: 1 },
    ] },
  ],
  dayTotals: [
    { month: "2026-01", date: "2026-01-01", recordCount: 2, totalsByCurrency: [
      { currency: "TWD", coefficient: "10000", scale: 2, count: 1 },
      { currency: "USD", coefficient: "250", scale: 2, count: 1 },
    ] },
    { month: "2026-02", date: "2026-02-01", recordCount: 1, totalsByCurrency: [
      { currency: "TWD", coefficient: "2500", scale: 2, count: 1 },
    ] },
  ],
  categoryTotalsByMonth: [
    { month: "2026-01", currency: "TWD", categoryCode: null, coefficient: "10000", scale: 2, count: 1 },
    { month: "2026-01", currency: "USD", categoryCode: null, coefficient: "250", scale: 2, count: 1 },
    { month: "2026-02", currency: "TWD", categoryCode: null, coefficient: "2500", scale: 2, count: 1 },
  ],
};
const crossMonthConfirmed = applySpendingSummaryDelta(exactSummary, 6, 7, {
  before: [
    { date: "2026-01-01", amount: { currency: "TWD", coefficient: "10000", scale: 2 }, category: { mode: "absent" as const } },
    { date: "2026-02-01", amount: { currency: "TWD", coefficient: "2500", scale: 2 }, category: { mode: "absent" as const } },
  ],
  after: [{ date: "2026-01-01", amount: { currency: "TWD", coefficient: "2500", scale: 2 }, category: { mode: "absent" as const } }],
});
const compactActionResult = {
  action: "confirm" as const,
  kind: "direct" as const,
  baseKnowledgeAt: 6,
  knowledgeAt: 7,
  invoiceIdentityId: "invoice-1",
  transactionIdentityId: "transaction-1",
  summaryDelta: {
    before: [
      { date: "2026-01-01", amount: { currency: "TWD", coefficient: "10000", scale: 2 }, category: { mode: "absent" as const } },
      { date: "2026-02-01", amount: { currency: "TWD", coefficient: "2500", scale: 2 }, category: { mode: "absent" as const } },
    ],
    after: [{ date: "2026-01-01", amount: { currency: "TWD", coefficient: "2500", scale: 2 }, category: { mode: "absent" as const } }],
  },
  affectedRecords: [],
};
const actionAfterLive = reconcileSpendingPageActionSummary(crossMonthConfirmed, 7, compactActionResult);
assert.equal(actionAfterLive.state, "already-current");
assert.equal(actionAfterLive.summary, crossMonthConfirmed);
assert.deepEqual(
  reconcileSpendingPageActionSummary(exactSummary, 6, compactActionResult),
  { state: "apply-delta", summary: crossMonthConfirmed },
  "when the action result arrives before the live summary, apply the delta once",
);
assert.deepEqual(
  reconcileSpendingPageActionSummary(crossMonthConfirmed, 8, compactActionResult),
  { state: "newer-live-version", summary: crossMonthConfirmed },
  "a newer live report wins over a delayed action result",
);
assert.deepEqual(
  {
    recordCount: crossMonthConfirmed.recordCount,
    totalsByCurrency: crossMonthConfirmed.totalsByCurrency,
    months: crossMonthConfirmed.monthTotals.map(({ month, recordCount, activeDayCount, totalsByCurrency }) => ({ month, recordCount, activeDayCount, totalsByCurrency })),
    days: crossMonthConfirmed.dayTotals.map(({ date, recordCount, totalsByCurrency }) => ({ date, recordCount, totalsByCurrency })),
    candidateState: crossMonthConfirmed.candidateState,
    pendingCandidateCount: crossMonthConfirmed.pendingCandidateCount,
  },
  {
    recordCount: 2,
    totalsByCurrency: [{ currency: "TWD", coefficient: "2500", scale: 2, count: 1 }, { currency: "USD", coefficient: "250", scale: 2, count: 1 }],
    months: [
      { month: "2026-01", recordCount: 2, activeDayCount: 1, totalsByCurrency: [{ currency: "TWD", coefficient: "2500", scale: 2, count: 1 }, { currency: "USD", coefficient: "250", scale: 2, count: 1 }] },
    ],
    days: [
      { date: "2026-01-01", recordCount: 2, totalsByCurrency: [{ currency: "TWD", coefficient: "2500", scale: 2, count: 1 }, { currency: "USD", coefficient: "250", scale: 2, count: 1 }] },
    ],
    candidateState: "unloaded",
    pendingCandidateCount: null,
  },
  "a cross-month link moves only the linked transaction amount onto the invoice date and removes an emptied day/month",
);
const restoredLargeScale = applySpendingSummaryDelta(crossMonthConfirmed, 7, 8, {
  before: [{ date: "2026-01-01", amount: { currency: "TWD", coefficient: "2500", scale: 2 }, category: { mode: "absent" as const } }],
  after: [
    { date: "2026-01-01", amount: { currency: "TWD", coefficient: "10000", scale: 2 }, category: { mode: "absent" as const } },
    { date: "2026-02-01", amount: { currency: "TWD", coefficient: "25000", scale: 3 }, category: { mode: "absent" as const } },
  ],
});
assert.deepEqual(
  {
    recordCount: restoredLargeScale.recordCount,
    amount: restoredLargeScale.totalsByCurrency.find((amount) => amount.currency === "TWD"),
    months: restoredLargeScale.monthTotals.map(({ month, recordCount, activeDayCount }) => ({ month, recordCount, activeDayCount })),
  },
  {
    recordCount: 3,
    amount: { currency: "TWD", coefficient: "125000", scale: 3, count: 2 },
    months: [
      { month: "2026-01", recordCount: 2, activeDayCount: 1 },
      { month: "2026-02", recordCount: 1, activeDayCount: 1 },
    ],
  },
  "a revoke can raise the exact aggregate scale without changing its numeric value",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2026-12"]), "2026-01", "2026-01-01"),
  { selectedMonth: "2026-01", selectedDay: "2026-01-01" },
  "a new report version keeps a still-valid month/day selection after confirmation",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2026-12"]), "2026-01", "2026-12-31"),
  { selectedMonth: "2026-01", selectedDay: null },
  "a day outside the retained month is cleared",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01"]), compactSummary(["2026-02"]), "2026-01", "2026-01-01"),
  { selectedMonth: null, selectedDay: null },
  "a removed month and its day are cleared",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2027-01"]), null, "2026-12-31"),
  { selectedMonth: null, selectedDay: null },
  "an implicit latest-month selection advances when a newer month arrives",
);
