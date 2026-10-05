import {
  addExact,
  divideExact,
  exactToNumber,
  multiplyExact,
  normalizeExact,
  type ExactAmount,
} from "../shared-money/exact.ts";
import type { SpendingPurchaseReportSummaryDto } from "./model.ts";

declare const brand: unique symbol;

/** `YYYY-MM`. Lexicographic order is chronological order. */
export type MonthKey = string & { readonly [brand]: "MonthKey" };
/** `YYYY-MM-DD`, the purchase-basis calendar date. */
export type IsoDate = string & { readonly [brand]: "IsoDate" };
/** ISO 4217 code as the summary reports it. Never mixed in one amount. */
export type CurrencyCode = string & { readonly [brand]: "CurrencyCode" };

/** Exact net amount in one currency. Refunds make it zero or negative. */
export type Money = Readonly<{ currency: CurrencyCode; coefficient: string; scale: number }>;

export type SpendingSummary = Pick<SpendingPurchaseReportSummaryDto, "monthTotals" | "dayTotals">;

/**
 * `in-progress` is today's month. Every comparison against usual is cut at
 * `throughDay` in each baseline month, so month-to-date never meets full months.
 */
export type MonthSpan =
  | Readonly<{ kind: "complete"; daysInMonth: number }>
  | Readonly<{ kind: "in-progress"; throughDay: number; daysInMonth: number }>;

/**
 * Usual is the previous 3 calendar months. The first month of history is a
 * partial import and never counts; quiet months inside history count as zero.
 * Fewer than 3 such months is `unavailable`: usual never averages 1 or 2 months.
 */
export type Usual =
  | Readonly<{ kind: "unavailable"; fullMonthsAvailable: 0 | 1 | 2 }>
  | Readonly<{
      kind: "available";
      /** Oldest first. */
      months: readonly [MonthKey, MonthKey, MonthKey];
      /** Mean of the 3 totals cut at the read month's span. */
      mean: Money;
      low: Money;
      high: Money;
      /** Mean of the 3 full-month totals. Equals `mean` for a complete month. */
      fullMonthMean: Money;
      /** The 3 full-month totals spread over their calendar days, quiet days included. */
      dailyMean: Money;
    }>;

/** Placement of the month-to-date total against the low..high range of usual. */
export type Standing =
  | Readonly<{ kind: "no-usual" }>
  | Readonly<{ kind: "above" | "within" | "below"; differenceFromMean: Money }>;

export type TotalCaveat =
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "may-include-duplicates"; pendingPairs: number }>
  | Readonly<{ kind: "confirmed" }>;

/**
 * `heavy`: at least twice the median positive baseline day, and among the
 * month's 3 largest such days. `quiet`: no record in this currency.
 * `future`: after `throughDay` of an in-progress month.
 */
export type DayTone = "spend" | "heavy" | "refund" | "quiet" | "future";

export type DayReading = Readonly<{
  date: IsoDate;
  day: number;
  net: Money;
  /** Geometry only. */
  value: number;
  /** Records on this date across all currencies. */
  recordCount: number;
  tone: DayTone;
}>;

/** Geometry only. Aligned with `days` by index. */
export type PacePoint = Readonly<{
  day: number;
  cumulative: number | null;
  usual: number | null;
  usualLow: number | null;
  usualHigh: number | null;
}>;

export type CurrencyMonthReading = Readonly<{
  currency: CurrencyCode;
  /** The month total from the summary. */
  total: Money;
  /** Total through `throughDay`; equals `total` for a complete month. */
  toDate: Money;
  usual: Usual;
  standing: Standing;
  activeDays: number;
  /** `toDate` over the elapsed days, quiet days included. */
  dailyMean: Money;
  /** null when there is no usual or no positive baseline day. */
  heavyThreshold: Money | null;
  days: readonly DayReading[];
  pace: readonly PacePoint[];
}>;

export type MonthReading = Readonly<{
  month: MonthKey;
  span: MonthSpan;
  /** Latest date with any record in the month. */
  latestRecordDate: IsoDate | null;
  recordCount: number;
  caveat: TotalCaveat;
  currencies: readonly CurrencyCode[];
  byCurrency: ReadonlyMap<CurrencyCode, CurrencyMonthReading>;
}>;

export type TrendMonth = Readonly<{
  month: MonthKey;
  total: Money;
  value: number;
  /** The month's own usual mean, cut like the month itself. */
  usualValue: number | null;
  status: "complete" | "in-progress" | "first-imported" | "before-history";
  /** Only months with records can be opened. */
  selectable: boolean;
}>;

export type ReadMonthInput = Readonly<{
  /** Falls back to the newest month when absent from history. */
  month: string | null;
  /** `YYYY-MM-DD` in the ledger's calendar. */
  today: string;
}>;

export type ReadTrendInput = Readonly<{
  currency: string;
  /** The window ends at the newest month and slides back only to keep this month in view. */
  selectedMonth: string;
  today: string;
  length?: number;
}>;

export function readSpendingMonth(summary: SpendingSummary, input: ReadMonthInput): MonthReading | null {
  const index = indexFor(summary);
  if (!index) return null;
  const month = input.month !== null && index.monthRows.has(input.month as MonthKey)
    ? input.month as MonthKey
    : index.newest;
  const span = spanOf(month, input.today);
  const row = index.monthRows.get(month);
  const pending = row?.pendingCandidateCount ?? null;
  const caveat: TotalCaveat = pending === null
    ? { kind: "checking" }
    : pending > 0
      ? { kind: "may-include-duplicates", pendingPairs: pending }
      : { kind: "confirmed" };
  return Object.freeze({
    month,
    span,
    latestRecordDate: index.latestDayByMonth.get(month) ?? null,
    recordCount: row?.recordCount ?? 0,
    caveat,
    currencies: index.currencies,
    byCurrency: new Map(index.currencies.map((currency) => [currency, readCurrency(index, currency, month, span)])),
  });
}

export function readSpendingTrend(summary: SpendingSummary, input: ReadTrendInput): readonly TrendMonth[] {
  const index = indexFor(summary);
  if (!index) return [];
  const length = input.length ?? 12;
  const currency = input.currency as CurrencyCode;
  const todayMonth = input.today.slice(0, 7);
  let end = index.newest;
  if (input.selectedMonth <= addMonths(end, -length)) end = addMonths(input.selectedMonth as MonthKey, length - 1);
  return Array.from({ length }, (_, offset) => {
    const month = addMonths(end, offset - length + 1);
    const span = spanOf(month, input.today);
    const total = monthTotal(index, currency, month);
    const usual = usualFor(index, currency, month, span);
    return Object.freeze({
      month,
      total: money(currency, total),
      value: exactToNumber(total),
      usualValue: usual.kind === "available" ? exactToNumber(usual.mean) : null,
      status: month < index.historyStart
        ? "before-history"
        : month === todayMonth
          ? "in-progress"
          : month === index.historyStart ? "first-imported" : "complete",
      selectable: index.monthRows.has(month),
    });
  });
}

type MonthRow = SpendingSummary["monthTotals"][number];

type MonthCells = Readonly<{
  nets: readonly ExactAmount[];
  present: readonly boolean[];
  cumulative: readonly ExactAmount[];
}>;

type SpendingIndex = Readonly<{
  historyStart: MonthKey;
  newest: MonthKey;
  currencies: readonly CurrencyCode[];
  monthRows: ReadonlyMap<MonthKey, MonthRow>;
  monthTotals: ReadonlyMap<string, ExactAmount>;
  dayNets: ReadonlyMap<string, ExactAmount>;
  dayRecordCounts: ReadonlyMap<IsoDate, number>;
  latestDayByMonth: ReadonlyMap<MonthKey, IsoDate>;
  cells: Map<string, MonthCells>;
}>;

const ZERO: ExactAmount = Object.freeze({ coefficient: "0", scale: 0 });
const indexCache = new WeakMap<SpendingSummary, SpendingIndex | null>();

function indexFor(summary: SpendingSummary): SpendingIndex | null {
  if (indexCache.has(summary)) return indexCache.get(summary) ?? null;
  const months = summary.monthTotals.map((row) => row.month as MonthKey).sort();
  const historyStart = months[0];
  const newest = months.at(-1);
  const index = historyStart && newest ? buildIndex(summary, historyStart, newest) : null;
  indexCache.set(summary, index);
  return index;
}

function buildIndex(summary: SpendingSummary, historyStart: MonthKey, newest: MonthKey): SpendingIndex {
  const currencies = new Set<string>();
  const monthTotals = new Map<string, ExactAmount>();
  for (const row of summary.monthTotals) {
    for (const amount of row.totalsByCurrency) {
      currencies.add(amount.currency);
      monthTotals.set(key(amount.currency, row.month), amount);
    }
  }
  const dayNets = new Map<string, ExactAmount>();
  const dayRecordCounts = new Map<IsoDate, number>();
  const latestDayByMonth = new Map<MonthKey, IsoDate>();
  for (const row of summary.dayTotals) {
    const date = row.date as IsoDate;
    const month = date.slice(0, 7) as MonthKey;
    dayRecordCounts.set(date, row.recordCount);
    if ((latestDayByMonth.get(month) ?? "") < date) latestDayByMonth.set(month, date);
    for (const amount of row.totalsByCurrency) {
      currencies.add(amount.currency);
      dayNets.set(key(amount.currency, date), amount);
    }
  }
  return {
    historyStart,
    newest,
    currencies: Object.freeze([...currencies].sort() as CurrencyCode[]),
    monthRows: new Map(summary.monthTotals.map((row) => [row.month as MonthKey, row])),
    monthTotals,
    dayNets,
    dayRecordCounts,
    latestDayByMonth,
    cells: new Map(),
  };
}

function cellsFor(index: SpendingIndex, currency: CurrencyCode, month: MonthKey): MonthCells {
  const cacheKey = key(currency, month);
  const cached = index.cells.get(cacheKey);
  if (cached) return cached;
  const nets: ExactAmount[] = [];
  const present: boolean[] = [];
  const cumulative: ExactAmount[] = [];
  let running = ZERO;
  for (let day = 1; day <= daysIn(month); day += 1) {
    const net = index.dayNets.get(key(currency, dateOf(month, day)));
    nets.push(net ?? ZERO);
    present.push(net !== undefined);
    running = net ? addExact(running, net) : running;
    cumulative.push(running);
  }
  const cells = { nets, present, cumulative };
  index.cells.set(cacheKey, cells);
  return cells;
}

function monthTotal(index: SpendingIndex, currency: CurrencyCode, month: MonthKey): ExactAmount {
  return index.monthTotals.get(key(currency, month)) ?? ZERO;
}

function throughDayOf(span: MonthSpan): number {
  return span.kind === "in-progress" ? span.throughDay : span.daysInMonth;
}

function cutTotal(index: SpendingIndex, currency: CurrencyCode, month: MonthKey, span: MonthSpan): ExactAmount {
  if (span.kind === "complete") return monthTotal(index, currency, month);
  const cumulative = cellsFor(index, currency, month).cumulative;
  return cumulative[Math.min(span.throughDay, cumulative.length) - 1] ?? ZERO;
}

function baselineMonths(index: SpendingIndex, month: MonthKey): readonly [MonthKey, MonthKey, MonthKey] | 0 | 1 | 2 {
  const months = [addMonths(month, -3), addMonths(month, -2), addMonths(month, -1)] as const;
  const eligible = months.filter((candidate) => candidate > index.historyStart).length;
  return eligible >= 3 ? months : eligible as 0 | 1 | 2;
}

function usualFor(index: SpendingIndex, currency: CurrencyCode, month: MonthKey, span: MonthSpan): Usual {
  const months = baselineMonths(index, month);
  if (typeof months === "number") return { kind: "unavailable", fullMonthsAvailable: months };
  const cut = months.map((candidate) => cutTotal(index, currency, candidate, span));
  const full = months.map((candidate) => monthTotal(index, currency, candidate));
  const scale = Math.max(0, ...full.map((value) => value.scale));
  const sorted = [...cut].sort(compare);
  const days = months.reduce((sum, candidate) => sum + daysIn(candidate), 0);
  return {
    kind: "available",
    months,
    mean: money(currency, mean(cut, cut.length, scale)),
    low: money(currency, sorted[0] ?? ZERO),
    high: money(currency, sorted.at(-1) ?? ZERO),
    fullMonthMean: money(currency, mean(full, full.length, scale)),
    dailyMean: money(currency, mean(full, days, scale)),
  };
}

function heavyThresholdFor(
  index: SpendingIndex,
  currency: CurrencyCode,
  usual: Usual,
): ExactAmount | null {
  if (usual.kind !== "available") return null;
  const positive = usual.months
    .flatMap((month) => cellsFor(index, currency, month).nets)
    .filter((net) => sign(net) > 0)
    .sort(compare);
  if (positive.length === 0) return null;
  const middle = Math.floor(positive.length / 2);
  const median = positive.length % 2 === 1
    ? positive[middle]
    : mean([positive[middle - 1], positive[middle]], 2, Math.max(...positive.map((value) => value.scale)) + 1);
  return multiplyExact(median, { coefficient: "2", scale: 0 });
}

const HEAVY_DAY_LIMIT = 3;

function readCurrency(
  index: SpendingIndex,
  currency: CurrencyCode,
  month: MonthKey,
  span: MonthSpan,
): CurrencyMonthReading {
  const cells = cellsFor(index, currency, month);
  const throughDay = throughDayOf(span);
  const total = monthTotal(index, currency, month);
  const toDate = cutTotal(index, currency, month, span);
  const usual = usualFor(index, currency, month, span);
  const threshold = heavyThresholdFor(index, currency, usual);
  const heavyDays = new Set(threshold === null ? [] : cells.nets
    .map((net, offset) => ({ net, day: offset + 1 }))
    .filter(({ net, day }) => day <= throughDay && sign(net) > 0 && compare(net, threshold) >= 0)
    .sort((left, right) => compare(right.net, left.net) || left.day - right.day)
    .slice(0, HEAVY_DAY_LIMIT)
    .map(({ day }) => day));

  const days = cells.nets.map((net, offset): DayReading => {
    const day = offset + 1;
    const date = dateOf(month, day);
    const tone: DayTone = day > throughDay
      ? "future"
      : !cells.present[offset]
        ? "quiet"
        : sign(net) < 0
          ? "refund"
          : heavyDays.has(day) ? "heavy" : "spend";
    return Object.freeze({
      date,
      day,
      net: money(currency, net),
      value: tone === "future" ? 0 : exactToNumber(net),
      recordCount: index.dayRecordCounts.get(date) ?? 0,
      tone,
    });
  });

  const baseline = usual.kind === "available"
    ? usual.months.map((candidate) => cellsFor(index, currency, candidate).cumulative)
    : null;
  const pace = cells.cumulative.map((cumulative, offset): PacePoint => {
    const day = offset + 1;
    const usualAt = baseline?.map((series) => exactToNumber(series[Math.min(day, series.length) - 1] ?? ZERO)) ?? null;
    return Object.freeze({
      day,
      cumulative: day <= throughDay ? exactToNumber(cumulative) : null,
      usual: usualAt ? usualAt.reduce((sum, value) => sum + value, 0) / usualAt.length : null,
      usualLow: usualAt ? Math.min(...usualAt) : null,
      usualHigh: usualAt ? Math.max(...usualAt) : null,
    });
  });

  const scale = Math.max(0, total.scale, toDate.scale);
  return Object.freeze({
    currency,
    total: money(currency, total),
    toDate: money(currency, toDate),
    usual,
    standing: standingOf(toDate, usual),
    activeDays: cells.present.filter((present, offset) => present && offset < throughDay).length,
    dailyMean: money(currency, mean([toDate], throughDay, scale)),
    heavyThreshold: threshold === null ? null : money(currency, threshold),
    days: Object.freeze(days),
    pace: Object.freeze(pace),
  });
}

function standingOf(toDate: ExactAmount, usual: Usual): Standing {
  if (usual.kind !== "available") return { kind: "no-usual" };
  const differenceFromMean = money(usual.mean.currency, subtract(toDate, usual.mean));
  if (compare(toDate, usual.high) > 0) return { kind: "above", differenceFromMean };
  if (compare(toDate, usual.low) < 0) return { kind: "below", differenceFromMean };
  return { kind: "within", differenceFromMean };
}

function spanOf(month: MonthKey, today: string): MonthSpan {
  const daysInMonth = daysIn(month);
  if (month !== today.slice(0, 7)) return { kind: "complete", daysInMonth };
  return { kind: "in-progress", throughDay: Math.min(Number(today.slice(8, 10)), daysInMonth), daysInMonth };
}

function money(currency: CurrencyCode, amount: ExactAmount): Money {
  const normalized = normalizeExact(amount);
  return Object.freeze({ currency, coefficient: normalized.coefficient, scale: normalized.scale });
}

function mean(values: readonly ExactAmount[], count: number, scale: number): ExactAmount {
  const sum = values.reduce<ExactAmount>((total, value) => addExact(total, value), ZERO);
  return divideExact(sum, { coefficient: String(count), scale: 0 }, scale) ?? ZERO;
}

function sign(value: ExactAmount): -1 | 0 | 1 {
  const coefficient = BigInt(value.coefficient);
  return coefficient > 0n ? 1 : coefficient < 0n ? -1 : 0;
}

function subtract(left: ExactAmount, right: ExactAmount): ExactAmount {
  return addExact(left, { coefficient: (-BigInt(right.coefficient)).toString(), scale: right.scale });
}

function compare(left: ExactAmount, right: ExactAmount): number {
  return sign(subtract(left, right));
}

function key(currency: string, period: string): string {
  return `${currency}|${period}`;
}

function daysIn(month: MonthKey): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function addMonths(month: MonthKey, offset: number): MonthKey {
  const absolute = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + offset;
  return `${String(Math.floor(absolute / 12)).padStart(4, "0")}-${String((absolute % 12) + 1).padStart(2, "0")}` as MonthKey;
}

function dateOf(month: MonthKey, day: number): IsoDate {
  return `${month}-${String(day).padStart(2, "0")}` as IsoDate;
}
