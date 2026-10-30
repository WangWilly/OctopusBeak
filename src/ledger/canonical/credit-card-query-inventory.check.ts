import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCreditCardQueryBucket,
  encodeCreditCardQueryBucket,
  isCompleteMonthTimeline,
  monthTimelineAnniversary,
  monthTimelineBucket,
  monthTimelineInventory,
  monthTimelineRowBucket,
  promisesBilledMonotonicity,
  statementGridProblem,
  statementGridQueryShortfalls,
  type CreditCardMonthTimeline,
  type CreditCardQueryBucket,
  type CreditCardStatementGrid,
  type CreditCardStatementGridBucket,
  type CreditCardStatementGridCompleteness,
  type CreditCardStatementGridShape,
} from "./credit-card-query-inventory.ts";

const buckets: readonly (readonly [CreditCardQueryBucket, string, boolean])[] = [
  [{ kind: "statement", period: "2026/09" }, '{"kind":"statement","period":"2026/09"}', true],
  [{ kind: "unbilled" }, '{"kind":"unbilled"}', false],
  [{ kind: "month", month: "2026/09" }, '{"kind":"month","month":"2026/09"}', true],
  [
    { kind: "partial-month", month: "2025/10", queriedOn: "2026-10-25" },
    '{"kind":"partial-month","month":"2025/10","queriedOn":"2026-10-25"}',
    true,
  ],
  [
    { kind: "history-range", start: "2025-10-25", end: "2026-10-25" },
    '{"kind":"history-range","start":"2025-10-25","end":"2026-10-25"}',
    false,
  ],
];

test("each query bucket kind has one stored key and decodes back to itself", () => {
  for (const [bucket, key] of buckets) {
    assert.equal(encodeCreditCardQueryBucket(bucket), key);
    assert.deepEqual(decodeCreditCardQueryBucket(key), bucket);
  }
});

test("the decoder accepts only the canonical structured key", () => {
  for (const legacy of [
    "statement:2026/09",
    "unbilled",
    "month:2026/09",
    "partial-month:2025/10:queried-on:2026-10-25",
    "history-range:2025-10-25:2026-10-25",
  ])
    assert.throws(() => decodeCreditCardQueryBucket(legacy), /not recognized/u, legacy);
  for (const malformed of [
    '{"period":"2026/09","kind":"statement"}',
    '{"kind":"statement", "period":"2026/09"}',
    '{"kind":"statement","period":""}',
    '{"kind":"statement","period":202609}',
    '{"kind":"statement"}',
    '{"kind":"unbilled","period":"2026/09"}',
    '{"kind":"quarter","quarter":"2026/Q3"}',
    '["statement","2026/09"]',
    "null",
  ])
    assert.throws(() => decodeCreditCardQueryBucket(malformed), /not recognized/u, malformed);
});

test("statement and month buckets promise billed monotonicity; unbilled and history ranges do not", () => {
  for (const [bucket, key, promise] of buckets)
    assert.equal(promisesBilledMonotonicity(bucket), promise, key);
});

const pagedShape: CreditCardStatementGridShape<"source-declared-total" | "short-page" | "provider-no-record"> = {
  label: "Paged",
  billedPeriodCount: 2,
  terminalEvidence: ["source-declared-total", "short-page", "provider-no-record"],
};
const noPagerShape: CreditCardStatementGridShape<"no-pager-terminal"> = {
  label: "NoPager",
  billedPeriodCount: 2,
  terminalEvidence: ["no-pager-terminal"],
};

const declared = (kind: "billed" | "unbilled", period: string, rows: number): CreditCardStatementGrid => ({
  kind, period, currentPage: 1, pageSize: 50, maximumPageSize: 50, capturedRowCount: rows, terminal: true,
  terminalEvidence: "source-declared-total", sourceDeclaredRowCount: rows, sourceDeclaredScopeRowCount: rows,
});
const shortPage = (kind: "billed" | "unbilled", period: string, rows: number): CreditCardStatementGrid => ({
  kind, period, currentPage: 1, pageSize: 50, maximumPageSize: 50, capturedRowCount: rows, terminal: true,
  terminalEvidence: "short-page",
});
const noRecord: CreditCardStatementGrid = {
  kind: "unbilled", period: "unbilled", capturedRowCount: 0, terminal: true, terminalEvidence: "provider-no-record",
};
const noPager = (kind: "billed" | "unbilled", period: string, rows: number): CreditCardStatementGrid => ({
  kind, period, currentPage: 1, pageSize: 50, capturedRowCount: rows, terminal: true, terminalEvidence: "no-pager-terminal",
});

type Row = Readonly<{ billingStatus: "billed" | "unbilled"; queryBucket: CreditCardStatementGridBucket }>;
const billedIn = (period: string): Row => ({ billingStatus: "billed", queryBucket: { kind: "statement", period } });
const unbilledRow: Row = { billingStatus: "unbilled", queryBucket: { kind: "unbilled" } };

function completeness(
  grids: readonly CreditCardStatementGrid[],
  overrides: Partial<CreditCardStatementGridCompleteness<CreditCardStatementGrid>> = {},
): CreditCardStatementGridCompleteness<CreditCardStatementGrid> {
  return {
    billedPeriods: ["2026/09", "2026/08"],
    unbilledIncluded: true,
    unfiltered: true,
    terminalGrids: true,
    rowCountsMatch: true,
    periodRowCounts: [1, 0],
    unbilledRowCount: 0,
    recordCount: 1,
    settledSummaryEvidencePresent: true,
    grids,
    ...overrides,
  };
}

test("a statement grid is complete with every declared period, terminal evidence the bank serves, and matching rows", () => {
  const rows = [billedIn("2026/09")];
  assert.equal(statementGridProblem(pagedShape, completeness([declared("billed", "2026/09", 1), shortPage("billed", "2026/08", 0), noRecord]), rows), undefined);
  assert.equal(statementGridProblem(noPagerShape, completeness([noPager("billed", "2026/09", 1), noPager("billed", "2026/08", 0), noPager("unbilled", "unbilled", 0)]), rows), undefined);
  assert.equal(
    statementGridProblem(
      pagedShape,
      completeness([declared("billed", "2026/09", 1), declared("billed", "2026/08", 0), declared("unbilled", "unbilled", 1)], { unbilledRowCount: 1, recordCount: 2 }),
      [...rows, unbilledRow],
    ),
    undefined,
  );
});

test("a statement grid that misses any part of its inventory names what is missing", () => {
  const grids = [declared("billed", "2026/09", 1), shortPage("billed", "2026/08", 0), noRecord];
  const rows = [billedIn("2026/09")];
  const cases: readonly (readonly [string, CreditCardStatementGridShape<CreditCardStatementGrid["terminalEvidence"]>, CreditCardStatementGridCompleteness<CreditCardStatementGrid>, readonly Row[], RegExp])[] = [
    ["one billed period short", pagedShape, completeness(grids, { billedPeriods: ["2026/09"] }), rows, /requires 2 distinct billed periods/u],
    ["a repeated billed period", pagedShape, completeness(grids, { billedPeriods: ["2026/09", "2026/09"] }), rows, /requires 2 distinct billed periods/u],
    ["no unbilled grid", pagedShape, completeness(grids, { unbilledIncluded: false }), rows, /must include the unbilled grid/u],
    ["a filtered grid", pagedShape, completeness(grids, { unfiltered: false }), rows, /unfiltered grid/u],
    ["the unbilled grid first", pagedShape, completeness([noRecord, declared("billed", "2026/09", 1), shortPage("billed", "2026/08", 0)]), rows, /lack accepted terminal evidence/u],
    ["evidence this bank never serves", noPagerShape, completeness(grids), rows, /lack accepted terminal evidence/u],
    ["a full page without a declared total", pagedShape, completeness([declared("billed", "2026/09", 1), shortPage("billed", "2026/08", 50), noRecord], { periodRowCounts: [1, 50] }), rows, /lack accepted terminal evidence/u],
    ["grids out of period order", pagedShape, completeness([shortPage("billed", "2026/08", 0), declared("billed", "2026/09", 1), noRecord]), rows, /grid periods or row counts/u],
    ["a declared total that disagrees", pagedShape, completeness(grids, { periodRowCounts: [0, 1] }), rows, /grid periods or row counts/u],
    ["records that drifted from the counts", pagedShape, completeness(grids), [...rows, billedIn("2026/09")], /drifted from records/u],
    ["no settled summary evidence", pagedShape, completeness(grids, { settledSummaryEvidencePresent: false }), rows, /settled statement summary evidence/u],
    ["a billed row in the unbilled bucket", pagedShape, completeness(grids), [{ billingStatus: "billed", queryBucket: { kind: "unbilled" } }], /conflicts with its billing status/u],
    ["a billed row outside the queried periods", pagedShape, completeness(grids), [billedIn("2026/07")], /outside the complete grid inventory/u],
  ];
  for (const [name, shape, input, caseRows, expected] of cases)
    assert.match(statementGridProblem(shape, input, caseRows) ?? "complete", expected, name);
});

test("a statement-grid query reports each shortfall before admission", () => {
  const terminal = [true, true, true];
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09", "2026/08"], terminalGrids: terminal }), []);
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09"], terminalGrids: terminal }), ["billed-period-count"]);
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09", "2026/09"], terminalGrids: terminal }), ["billed-period-invalid"]);
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09", ""], terminalGrids: terminal }), ["billed-period-invalid"]);
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09", "2026/08"], terminalGrids: [true, true] }), ["grid-count"]);
  assert.deepEqual(statementGridQueryShortfalls(pagedShape, { billedPeriods: ["2026/09", "2026/08"], terminalGrids: [true, false, true] }), ["grid-not-terminal"]);
});

function timeline(queryDate: string, monthCount: 12 | 13, overrides: Partial<CreditCardMonthTimeline> = {}): CreditCardMonthTimeline {
  const [year, month] = queryDate.split("-").map(Number);
  const months = Array.from({ length: monthCount }, (_, index) => {
    const ordinal = year! * 12 + month! - 1 - index;
    return `${Math.floor(ordinal / 12)}/${String((ordinal % 12) + 1).padStart(2, "0")}`;
  });
  return {
    kind: "past-year-timeline",
    firstMonth: months[0]!,
    lastMonth: months.at(-1)!,
    months,
    pageCount: 3,
    monthCount,
    capturedRowCount: 4,
    terminal: true,
    terminalCursor: 4,
    ...overrides,
  };
}

test("a month timeline is complete only as one terminal traversal from the query month to its anniversary month", () => {
  assert.equal(isCompleteMonthTimeline(timeline("2026-10-25", 13), "2025-10-25", "2026-10-25", 4), true);
  assert.equal(isCompleteMonthTimeline(timeline("2026-10-25", 12), "2025-11-01", "2026-10-25", 4), true);
  assert.equal(isCompleteMonthTimeline(timeline("2026-10-25", 13), "2025-10-25", "2026-10-25", 5), false, "row count drift");
  assert.equal(isCompleteMonthTimeline(timeline("2026-10-25", 13, { terminalCursor: 3 as 4 }), "2025-10-25", "2026-10-25", 4), false, "not terminal");
  const skipped = timeline("2026-10-25", 13);
  assert.equal(isCompleteMonthTimeline({ ...skipped, months: [...skipped.months.slice(0, 5), "2026/04", ...skipped.months.slice(6)] }, "2025-10-25", "2026-10-25", 4), false, "a month out of sequence");
});

test("the anniversary month is a partial bucket that names its query date; a combined grid is one history range", () => {
  const query = timeline("2026-10-25", 13);
  const inventory = monthTimelineInventory(query, "2025-10-25", "2026-10-25");
  assert.deepEqual(inventory[0], { kind: "month", month: "2026/10" });
  assert.deepEqual(inventory.at(-1), { kind: "partial-month", month: "2025/10", queriedOn: "2026-10-25" });
  assert.deepEqual(monthTimelineRowBucket(query, "2025-10-30", "2025-10-25", "2026-10-25"), { kind: "partial-month", month: "2025/10", queriedOn: "2026-10-25" });
  assert.deepEqual(monthTimelineRowBucket(query, "2026-03-02", "2025-10-25", "2026-10-25"), { kind: "month", month: "2026/03" });
  assert.deepEqual(monthTimelineInventory({ kind: "combined" }, "2026-04-01", "2026-10-25"), [{ kind: "history-range", start: "2026-04-01", end: "2026-10-25" }]);
  assert.deepEqual(monthTimelineRowBucket({ kind: "combined" }, "2026-05-02", "2026-04-01", "2026-10-25"), { kind: "history-range", start: "2026-04-01", end: "2026-10-25" });
});

test("a leap day's anniversary clamps to Feb 28 and its month stays the partial bucket", () => {
  for (const [queryDate, anniversary] of [
    ["2028-02-29", "2027-02-28"],
    ["2024-02-29", "2023-02-28"],
    ["2028-03-01", "2027-03-01"],
    ["2026-10-25", "2025-10-25"],
  ] as const) {
    assert.equal(monthTimelineAnniversary(queryDate), anniversary, queryDate);
  }
  assert.deepEqual(monthTimelineBucket("2027/02", "2028-02-29"), { kind: "partial-month", month: "2027/02", queriedOn: "2028-02-29" });
  assert.deepEqual(monthTimelineBucket("2027/03", "2028-02-29"), { kind: "month", month: "2027/03" });
});
