import assert from "node:assert/strict";
import {
  applySpendingSummaryDelta,
  preserveSpendingMonthSelection,
  reconcileSpendingPageActionSummary,
  spendingCanonicalAt,
  spendingMonths,
  type CanonicalSpendingView,
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
assert.throws(
  () => reconcileSpendingPageActionSummary(exactSummary, 5, compactActionResult),
  /does not match the action result base version/u,
  "a summary from neither side of the action cannot take its delta; the worker recomputes instead",
);
{
  const before = { availability: "empty", knowledgePoint: 6, totalStatus: "complete", totalsByCurrency: [] } as unknown as CanonicalSpendingView;
  const canonical = spendingCanonicalAt(before, crossMonthConfirmed, 7);
  assert.equal(canonical.availability, crossMonthConfirmed.recordCount > 0 ? "available" : "empty");
  assert.equal(canonical.knowledgePoint, 7, "the canonical view moves to the action version");
  assert.deepEqual(canonical.totalsByCurrency, crossMonthConfirmed.totalsByCurrency.map((amount) => ({
    currency: amount.currency,
    value: Number(amount.coefficient) / 10 ** amount.scale,
    exact: { coefficient: amount.coefficient, scale: amount.scale },
  })), "totals keep the exact amount beside its number");
}
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
    totalsByCurrency: [{ currency: "TWD", coefficient: "25", scale: 0, count: 1 }, { currency: "USD", coefficient: "25", scale: 1, count: 1 }],
    months: [
      { month: "2026-01", recordCount: 2, activeDayCount: 1, totalsByCurrency: [{ currency: "TWD", coefficient: "25", scale: 0, count: 1 }, { currency: "USD", coefficient: "25", scale: 1, count: 1 }] },
    ],
    days: [
      { date: "2026-01-01", recordCount: 2, totalsByCurrency: [{ currency: "TWD", coefficient: "25", scale: 0, count: 1 }, { currency: "USD", coefficient: "25", scale: 1, count: 1 }] },
    ],
    candidateState: "unloaded",
    pendingCandidateCount: null,
  },
  "a cross-month link moves only the linked transaction amount onto the invoice date, removes an emptied day/month, and reduces like the server",
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
    amount: { currency: "TWD", coefficient: "125", scale: 0, count: 2 },
    months: [
      { month: "2026-01", recordCount: 2, activeDayCount: 1 },
      { month: "2026-02", recordCount: 1, activeDayCount: 1 },
    ],
  },
  "a finer-scale delta amount still yields the reduced total the server reports",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2026-12"]), "2026-01", "2026-01-01", "2026-12"),
  { selectedMonth: "2026-01", selectedDay: "2026-01-01" },
  "a new report version keeps a still-valid month/day selection after confirmation",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2026-12"]), "2026-01", "2026-12-31", "2026-12"),
  { selectedMonth: "2026-01", selectedDay: null },
  "a day outside the retained month is cleared",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01"]), compactSummary(["2026-02"]), "2026-01", "2026-01-01", "2026-02"),
  { selectedMonth: null, selectedDay: null },
  "a removed month and its day are cleared",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-01", "2026-12"]), compactSummary(["2026-01", "2026-12"]), null, "2026-12-31", "2027-01"),
  { selectedMonth: null, selectedDay: null },
  "the implicit month is today's month, so a day from the newest data month is cleared",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-12"]), compactSummary(["2026-12"]), null, "2027-01-03", "2027-01"),
  { selectedMonth: null, selectedDay: "2027-01-03" },
  "a day in today's month survives even before that month has data",
);
assert.deepEqual(
  preserveSpendingMonthSelection(compactSummary(["2026-12"]), compactSummary(["2026-12"]), "2027-01", null, "2027-01"),
  { selectedMonth: "2027-01", selectedDay: null },
  "an explicit pick of today's empty month stays valid",
);
assert.deepEqual(spendingMonths(["2026-09", "2026-08"], "2026-10"), ["2026-08", "2026-09", "2026-10"], "today's month joins the data months");
assert.deepEqual(spendingMonths(["2026-10", "2026-11"], "2026-10"), ["2026-10", "2026-11"], "today's month is listed once, and later data months stay");
assert.deepEqual(spendingMonths([], "2026-10"), ["2026-10"], "a ledger with no data still opens today's month");

{
  // A split component the server names `twd` lands in the summary's TWD bucket, reduced.
  const component = (categoryCode: string, coefficient: string, currency: string) => ({
    categoryCode,
    labels: null,
    taxonomyId: "personal",
    taxonomyVersion: "1",
    amount: { coefficient, scale: 2, currency },
  });
  const split = applySpendingSummaryDelta(exactSummary, 6, 7, {
    before: [],
    after: [{
      date: "2026-01-02",
      amount: { currency: "twd", coefficient: "3000", scale: 2 },
      category: { mode: "split", origin: "user", subject: "items", components: [component("food", "1000", "twd"), component("transport", "2000", "twd")] },
    }],
  });
  assert.deepEqual(split.totalsByCurrency, [
    { currency: "TWD", coefficient: "155", scale: 0, count: 3 },
    { currency: "USD", coefficient: "25", scale: 1, count: 1 },
  ], "a lowercase delta currency adds to the upper-cased total");
  assert.deepEqual(split.categoryTotalsByMonth.filter((row) => row.month === "2026-01"), [
    { month: "2026-01", currency: "TWD", categoryCode: null, coefficient: "100", scale: 0, count: 1 },
    { month: "2026-01", currency: "TWD", categoryCode: "food", coefficient: "10", scale: 0, count: 1 },
    { month: "2026-01", currency: "TWD", categoryCode: "transport", coefficient: "20", scale: 0, count: 1 },
    { month: "2026-01", currency: "USD", categoryCode: null, coefficient: "25", scale: 1, count: 1 },
  ], "split components join the upper-cased category bucket");
}

{
  // Property: applying a delta and then its reverse returns the summary unchanged.
  let state = 0x5eed10;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const integer = (max: number) => Math.floor(random() * (max + 1));
  const pick = <T>(values: readonly T[]): T => values[integer(values.length - 1)]!;
  const line = () => {
    const currency = pick(["TWD", "twd", "USD"]);
    const amount = { currency, coefficient: String(integer(200000) - 20000), scale: integer(3) };
    const date = `2026-0${1 + integer(2)}-0${1 + integer(3)}`;
    const roll = integer(2);
    const category = roll === 0
      ? { mode: "absent" as const }
      : roll === 1
        ? { mode: "single" as const, origin: "user" as const, subject: "transaction" as const, categoryCode: pick(["food", "home"]), labels: null, taxonomyId: "personal", taxonomyVersion: "1" }
        : { mode: "split" as const, origin: "user" as const, subject: "items" as const, components: ["food", "home"].map((categoryCode) => ({
            categoryCode, labels: null, taxonomyId: "personal", taxonomyVersion: "1",
            amount: { currency, coefficient: String(integer(5000)), scale: integer(3) },
          })) };
    return { date, amount: integer(9) === 0 ? null : amount, category };
  };
  const empty: SpendingPurchaseReportSummaryDto = {
    recordCount: 0, candidateCount: null, pendingCandidateCount: null, candidateState: "unloaded", currencies: [],
    totalsByCurrency: [], monthTotals: [], dayTotals: [], categoryTotalsByMonth: [],
  };
  for (let run = 0; run < 200; run += 1) {
    const base = Array.from({ length: 1 + integer(6) }, line);
    const summary = applySpendingSummaryDelta(empty, 1, 2, { before: [], after: base });
    const removed = base.filter(() => random() < 0.5);
    const added = Array.from({ length: integer(4) }, line);
    const applied = applySpendingSummaryDelta(summary, 2, 3, { before: removed, after: added });
    const reverted = applySpendingSummaryDelta(applied, 3, 4, { before: added, after: removed });
    assert.deepEqual(reverted, summary, `run ${run}: apply then revert is the identity`);
  }
}
