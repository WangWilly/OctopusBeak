/**
 * Credit-card Query Buckets and the Query Inventory shapes every card source
 * declares (ADR 0062). Inventory decides which prior occurrences a capture is
 * expected to contain; it never participates in occurrence identity.
 */

export type CreditCardQueryBucket =
  | Readonly<{ kind: "statement"; period: string }>
  | Readonly<{ kind: "unbilled" }>
  | Readonly<{ kind: "month"; month: string }>
  | Readonly<{ kind: "partial-month"; month: string; queriedOn: string }>
  | Readonly<{ kind: "history-range"; start: string; end: string }>;

export type CreditCardStatementGridBucket = Extract<CreditCardQueryBucket, { kind: "statement" | "unbilled" }>;
export type CreditCardTimelineBucket = Exclude<CreditCardQueryBucket, CreditCardStatementGridBucket>;

const BILLED_MONOTONICITY: Readonly<Record<CreditCardQueryBucket["kind"], boolean>> = {
  statement: true,
  month: true,
  "partial-month": true,
  unbilled: false,
  "history-range": false,
};

/** Whether re-querying this bucket never decreases an occurrence group's billed members. */
export function promisesBilledMonotonicity(bucket: CreditCardQueryBucket): boolean {
  return BILLED_MONOTONICITY[bucket.kind];
}

/** Each kind's fields in stored order, after `kind`. */
const BUCKET_FIELDS: Readonly<Record<CreditCardQueryBucket["kind"], readonly string[]>> = {
  statement: ["period"],
  unbilled: [],
  month: ["month"],
  "partial-month": ["month", "queriedOn"],
  "history-range": ["start", "end"],
};

/**
 * The stored bucket key: compact JSON with `kind` first and each kind's fields
 * in a fixed order, so one bucket always has exactly one key.
 */
export function encodeCreditCardQueryBucket(bucket: CreditCardQueryBucket): string {
  const fields = bucket as Readonly<Record<string, string>>;
  return JSON.stringify(Object.fromEntries([
    ["kind", bucket.kind],
    ...BUCKET_FIELDS[bucket.kind].map((field) => [field, fields[field]]),
  ]));
}

export function decodeCreditCardQueryBucket(key: string): CreditCardQueryBucket {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    value = undefined;
  }
  const fields = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const kind = fields.kind;
  const names = typeof kind === "string" && Object.hasOwn(BUCKET_FIELDS, kind)
    ? BUCKET_FIELDS[kind as CreditCardQueryBucket["kind"]]
    : undefined;
  if (
    names === undefined ||
    names.some((name) => typeof fields[name] !== "string" || fields[name] === "") ||
    encodeCreditCardQueryBucket(fields as CreditCardQueryBucket) !== key
  )
    throw new Error("Credit-card query bucket key is not recognized.");
  return fields as CreditCardQueryBucket;
}

export function isBucketInInventory(
  inventory: readonly CreditCardQueryBucket[],
  bucket: CreditCardQueryBucket,
): boolean {
  const key = encodeCreditCardQueryBucket(bucket);
  return inventory.some((candidate) => encodeCreditCardQueryBucket(candidate) === key);
}

type StatementGridBase = {
  kind: "billed" | "unbilled";
  period: string;
  capturedRowCount: number;
  terminal: boolean;
  dueDateEvidence?: "explicit-date" | "provider-text-status";
};

type PagedStatementGridBase = StatementGridBase & {
  currentPage: number;
  pageSize: number;
  maximumPageSize: number;
};

/**
 * One queried statement-grid page and the evidence that it is terminal: a
 * provider-declared total, a short first page whose row count is strictly
 * below the requested maximum, the bank's explicit no-record page served in
 * place of an empty unbilled table, or a page that renders no pager at all.
 * The short-page variant deliberately carries no source-declared count:
 * observed rows are not promoted into provider evidence.
 */
export type CreditCardStatementGrid =
  | (PagedStatementGridBase & {
      terminalEvidence: "source-declared-total";
      sourceDeclaredRowCount: number;
      sourceDeclaredScopeRowCount: number;
    })
  | (PagedStatementGridBase & {
      terminalEvidence: "short-page";
      sourceDeclaredRowCount?: never;
      sourceDeclaredScopeRowCount?: never;
    })
  | (StatementGridBase & {
      kind: "unbilled";
      capturedRowCount: 0;
      terminalEvidence: "provider-no-record";
      currentPage?: never;
      pageSize?: never;
      maximumPageSize?: never;
      sourceDeclaredRowCount?: never;
      sourceDeclaredScopeRowCount?: never;
    })
  | {
      kind: "billed" | "unbilled";
      period: string;
      currentPage: number;
      pageSize: number;
      capturedRowCount: number;
      terminal: true;
      terminalEvidence: "no-pager-terminal";
    };

export type CreditCardStatementGridTerminalEvidence = CreditCardStatementGrid["terminalEvidence"];

/** A bank's statement grid: how many billed periods it queries and which terminal evidence it serves. */
export type CreditCardStatementGridShape<E extends CreditCardStatementGridTerminalEvidence> = Readonly<{
  label: string;
  billedPeriodCount: number;
  terminalEvidence: readonly E[];
}>;

export type CreditCardStatementGridOf<S extends CreditCardStatementGridShape<CreditCardStatementGridTerminalEvidence>> =
  Extract<CreditCardStatementGrid, { terminalEvidence: S["terminalEvidence"][number] }>;

export type CreditCardStatementGridCompleteness<G extends CreditCardStatementGrid> = {
  billedPeriods: readonly string[];
  unbilledIncluded: boolean;
  unfiltered: boolean;
  terminalGrids: boolean;
  rowCountsMatch: boolean;
  periodRowCounts: readonly number[];
  unbilledRowCount: number;
  recordCount: number;
  settledSummaryEvidencePresent: boolean;
  grids: readonly G[];
};

/** The billed periods in query order, then the unbilled listing. */
export function statementGridInventory(billedPeriods: readonly string[]): CreditCardStatementGridBucket[] {
  return [
    ...billedPeriods.map((period) => ({ kind: "statement" as const, period })),
    { kind: "unbilled" },
  ];
}

export type CreditCardStatementGridShortfall =
  | "billed-period-count"
  | "billed-period-invalid"
  | "grid-count"
  | "grid-not-terminal";

/**
 * What a statement-grid query still lacks before admission, for workflows that
 * diagnose an incomplete collection early. `terminalGrids` holds one entry per
 * queried grid, billed periods first and the unbilled listing last.
 */
export function statementGridQueryShortfalls(
  shape: CreditCardStatementGridShape<CreditCardStatementGridTerminalEvidence>,
  query: Readonly<{ billedPeriods: readonly string[]; terminalGrids: readonly boolean[] }>,
): CreditCardStatementGridShortfall[] {
  const periods = query.billedPeriods;
  return [
    ...(periods.length === shape.billedPeriodCount ? [] : ["billed-period-count" as const]),
    ...(periods.every((period) => period.length > 0) && new Set(periods).size === periods.length
      ? []
      : ["billed-period-invalid" as const]),
    ...(query.terminalGrids.length === shape.billedPeriodCount + 1 ? [] : ["grid-count" as const]),
    ...(query.terminalGrids.every(Boolean) ? [] : ["grid-not-terminal" as const]),
  ];
}

function hasValidTerminalEvidence(grid: CreditCardStatementGrid): boolean {
  switch (grid.terminalEvidence) {
    case "no-pager-terminal":
      return grid.currentPage === 1 &&
        Number.isSafeInteger(grid.pageSize) &&
        Number.isSafeInteger(grid.capturedRowCount) &&
        grid.capturedRowCount >= 0 &&
        grid.pageSize >= grid.capturedRowCount &&
        grid.terminal === true;
    case "provider-no-record":
      return grid.kind === "unbilled" &&
        grid.terminal === true &&
        grid.capturedRowCount === 0 &&
        !Object.hasOwn(grid, "currentPage") &&
        !Object.hasOwn(grid, "pageSize") &&
        !Object.hasOwn(grid, "maximumPageSize") &&
        !Object.hasOwn(grid, "sourceDeclaredRowCount") &&
        !Object.hasOwn(grid, "sourceDeclaredScopeRowCount");
    case "source-declared-total":
    case "short-page":
      break;
    default:
      return false;
  }
  if (
    !Number.isSafeInteger(grid.currentPage) ||
    grid.currentPage !== 1 ||
    !Number.isSafeInteger(grid.pageSize) ||
    !Number.isSafeInteger(grid.maximumPageSize) ||
    grid.maximumPageSize <= 0 ||
    grid.pageSize !== grid.maximumPageSize ||
    !grid.terminal ||
    !Number.isSafeInteger(grid.capturedRowCount) ||
    grid.capturedRowCount < 0 ||
    grid.capturedRowCount > grid.pageSize
  )
    return false;
  if (grid.terminalEvidence === "source-declared-total")
    return Object.hasOwn(grid, "sourceDeclaredRowCount") &&
      Object.hasOwn(grid, "sourceDeclaredScopeRowCount") &&
      Number.isSafeInteger(grid.sourceDeclaredRowCount) &&
      grid.sourceDeclaredRowCount >= 0 &&
      grid.capturedRowCount === grid.sourceDeclaredRowCount &&
      Number.isSafeInteger(grid.sourceDeclaredScopeRowCount) &&
      grid.sourceDeclaredScopeRowCount >= grid.sourceDeclaredRowCount;
  return !Object.hasOwn(grid, "sourceDeclaredRowCount") &&
    !Object.hasOwn(grid, "sourceDeclaredScopeRowCount") &&
    grid.capturedRowCount < grid.pageSize;
}

function gridCountsMatch(grid: CreditCardStatementGrid, rowCount: number | undefined): boolean {
  return grid.capturedRowCount === rowCount &&
    (grid.terminalEvidence !== "source-declared-total" || grid.sourceDeclaredRowCount === rowCount);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Why a statement-grid capture is not a complete Query Inventory, or
 * undefined when it is: every declared billed period plus the unbilled
 * listing, each terminal by evidence the bank serves, with row counts that
 * match the records and every record inside the inventory in the bucket its
 * billing status implies.
 */
export function statementGridProblem<G extends CreditCardStatementGrid>(
  shape: CreditCardStatementGridShape<G["terminalEvidence"]>,
  completeness: CreditCardStatementGridCompleteness<G>,
  rows: readonly Readonly<{ billingStatus: "billed" | "unbilled"; queryBucket: CreditCardStatementGridBucket }>[],
): string | undefined {
  const label = `${shape.label} credit-card`;
  const periodCount = shape.billedPeriodCount;
  const periods = completeness.billedPeriods;
  if (
    !Array.isArray(periods) ||
    periods.length !== periodCount ||
    periods.some((period) => typeof period !== "string" || period.length === 0) ||
    new Set(periods).size !== periodCount
  )
    return `${label} capture requires ${periodCount} distinct billed periods.`;
  if (completeness.unbilledIncluded !== true) return `${label} capture must include the unbilled grid.`;
  if (completeness.unfiltered !== true) return `${label} completeness requires an unfiltered grid.`;
  if (completeness.terminalGrids !== true) return `${label} capture requires terminal grids.`;
  if (completeness.rowCountsMatch !== true) return `${label} grid row counts do not match captured records.`;
  if (
    !Array.isArray(completeness.periodRowCounts) ||
    completeness.periodRowCounts.length !== periodCount ||
    !completeness.periodRowCounts.every(isNonNegativeInteger) ||
    !isNonNegativeInteger(completeness.unbilledRowCount) ||
    !isNonNegativeInteger(completeness.recordCount)
  )
    return `${label} completeness counts are invalid.`;
  const grids = completeness.grids;
  if (
    !Array.isArray(grids) ||
    grids.length !== periodCount + 1 ||
    grids.some((grid, index) =>
      grid.kind !== (index < periodCount ? "billed" : "unbilled") ||
      !shape.terminalEvidence.includes(grid.terminalEvidence) ||
      !hasValidTerminalEvidence(grid))
  )
    return `${label} grids lack accepted terminal evidence.`;
  const unbilledGrid = grids[periodCount]!;
  if (
    grids.slice(0, periodCount).some((grid, index) =>
      grid.period !== periods[index] || !gridCountsMatch(grid, completeness.periodRowCounts[index])) ||
    unbilledGrid.period !== "unbilled" ||
    !gridCountsMatch(unbilledGrid, completeness.unbilledRowCount)
  )
    return `${label} grid periods or row counts do not match completeness evidence.`;
  const billedCount = rows.filter((row) => row.billingStatus === "billed").length;
  if (
    completeness.recordCount !== rows.length ||
    completeness.unbilledRowCount !== rows.length - billedCount ||
    completeness.periodRowCounts.reduce((sum, count) => sum + count, 0) !== billedCount
  )
    return `${label} completeness count drifted from records.`;
  if (completeness.settledSummaryEvidencePresent !== true)
    return `${label} capture is missing settled statement summary evidence.`;
  const inventory = statementGridInventory(periods);
  for (const row of rows) {
    if ((row.billingStatus === "billed") !== (row.queryBucket.kind === "statement"))
      return `${shape.label} transaction query bucket conflicts with its billing status.`;
    if (!isBucketInInventory(inventory, row.queryBucket))
      return `${shape.label} transaction query bucket is outside the complete grid inventory.`;
  }
  return undefined;
}

/**
 * E.SUN's past-year timeline: one terminal traversal of every month from the
 * query date's month back to the month of its anniversary one year earlier.
 */
export type CreditCardMonthTimeline = {
  kind: "past-year-timeline";
  firstMonth: string;
  lastMonth: string;
  months: readonly string[];
  pageCount: number;
  monthCount: number;
  capturedRowCount: number;
  terminal: true;
  terminalCursor: 4;
};

function timelineMonth(date: string): string {
  return date.slice(0, 7).replace("-", "/");
}

export function isCompleteMonthTimeline(
  timeline: CreditCardMonthTimeline,
  startDate: string,
  endDate: string,
  rowCount: number,
): boolean {
  const firstMonth = timelineMonth(endDate);
  const lastMonth = timelineMonth(startDate);
  const [firstYear, firstNumber] = firstMonth.split("/").map(Number);
  const [lastYear, lastNumber] = lastMonth.split("/").map(Number);
  const span = (firstYear! - lastYear!) * 12 + firstNumber! - lastNumber!;
  return timeline.kind === "past-year-timeline" &&
    timeline.terminal === true &&
    timeline.terminalCursor === 4 &&
    timeline.firstMonth === firstMonth &&
    timeline.lastMonth === lastMonth &&
    (span === 11 || span === 12) &&
    timeline.monthCount === span + 1 &&
    Array.isArray(timeline.months) &&
    timeline.months.length === timeline.monthCount &&
    timeline.months.every((month, index) => {
      if (!/^\d{4}\/(?:0[1-9]|1[0-2])$/u.test(month)) return false;
      const [year, number] = month.split("/").map(Number);
      return year! * 12 + number! === firstYear! * 12 + firstNumber! - index;
    }) &&
    Number.isSafeInteger(timeline.pageCount) &&
    timeline.pageCount > 0 &&
    timeline.pageCount <= timeline.monthCount &&
    timeline.capturedRowCount === rowCount;
}

/**
 * The past-year timeline returns purchases only from about the query date's
 * anniversary one year earlier (ADR 0031); anything on or before it may
 * already have left the timeline. `queryDate` is YYYY-MM-DD.
 */
export function monthTimelineAnniversary(queryDate: string): string {
  return `${String(Number(queryDate.slice(0, 4)) - 1).padStart(4, "0")}${queryDate.slice(4)}`;
}

/**
 * The anniversary month loses purchases day by day while it is still listed.
 * Its bucket names the query date: a later day's capture has not queried it
 * again, while a same-day capture must still contain every member (ADR 0040).
 */
export function monthTimelineBucket(month: string, queryDate: string): CreditCardTimelineBucket {
  return month === timelineMonth(monthTimelineAnniversary(queryDate))
    ? { kind: "partial-month", month, queriedOn: queryDate }
    : { kind: "month", month };
}

/**
 * The month timeline's query: the past-year traversal, or one combined grid
 * over the whole capture range when no month traversal was used.
 */
export type CreditCardTimelineQuery =
  | Readonly<{ kind: "past-year-timeline"; months: readonly string[] }>
  | Readonly<{ kind: "combined" }>;

/** Every bucket a timeline capture queried. Dates are YYYY-MM-DD. */
export function monthTimelineInventory(
  query: CreditCardTimelineQuery,
  startDate: string,
  endDate: string,
): CreditCardTimelineBucket[] {
  return query.kind === "past-year-timeline"
    ? query.months.map((month) => monthTimelineBucket(month, endDate))
    : [{ kind: "history-range", start: startDate, end: endDate }];
}

/** The bucket that returned a row consumed on `consumeDate`. Dates are YYYY-MM-DD. */
export function monthTimelineRowBucket(
  query: CreditCardTimelineQuery,
  consumeDate: string,
  startDate: string,
  endDate: string,
): CreditCardTimelineBucket {
  return query.kind === "past-year-timeline"
    ? monthTimelineBucket(timelineMonth(consumeDate), endDate)
    : { kind: "history-range", start: startDate, end: endDate };
}
