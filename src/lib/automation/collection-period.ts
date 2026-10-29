/**
 * ADR 0077: the dates a Verified product queries before a Source Capture.
 * A product declares a look-back and a widest provider request; the run
 * derives "today" in Asia/Taipei from its clock and turns the declaration
 * into a period and its query windows.
 */

/** A calendar date in YYYY-MM-DD. */
export type CalendarDate = string;

/**
 * A run of whole calendar dates ending on a given date. It covers the
 * dates from `end − years − months − days + 1 day` through `end`, both
 * inclusive: years and months move the date back first and clamp it to
 * the end of a shorter month (Mar 31 − 1 month = Feb 28 or 29), then
 * days move it back. So `{ months: 12 }` is twelve months inclusive and
 * `{ months: 1, days: 1 }` is one month and one more day.
 */
export type CollectionSpan = Readonly<{ years?: number; months?: number; days?: number }>;

/** What a Verified product declares about the dates it queries. */
export type CollectionPeriodDeclaration = Readonly<{
  /** The span the period covers, ending today. */
  lookBack: CollectionSpan;
  /** The widest span one provider request may cover; absent means one request covers the period. */
  maxWindow?: CollectionSpan;
}>;

/** An inclusive date range one provider request covers. */
export type CollectionWindow = Readonly<{ start: CalendarDate; end: CalendarDate }>;

/** The dates a run queries for one product, and the requests that cover them. */
export type CollectionPeriod = Readonly<{
  start: CalendarDate;
  end: CalendarDate;
  /** Inclusive, disjoint, contiguous, newest first; together they cover `start` through `end`. */
  windows: readonly CollectionWindow[];
}>;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SOURCE_TIME_ZONE = "Asia/Taipei";

function parse(date: CalendarDate): number {
  const match = CALENDAR_DATE.exec(date);
  if (!match) throw new RangeError(`Invalid calendar date: ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = Date.UTC(year, month - 1, day);
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return value;
}

function format(value: number): CalendarDate {
  return new Date(value).toISOString().slice(0, 10);
}

function addDays(value: number, days: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function subtractMonthsClamped(value: number, months: number): number {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay));
}

function validSpan(span: CollectionSpan): void {
  const parts = [span.years ?? 0, span.months ?? 0, span.days ?? 0];
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0) || parts.every((part) => part === 0)) {
    throw new RangeError("A collection span needs a positive whole number of years, months or days.");
  }
}

/** The first date of `span` ending on `end`. */
function spanStart(end: number, span: CollectionSpan): number {
  const months = (span.years ?? 0) * 12 + (span.months ?? 0);
  return addDays(subtractMonthsClamped(end, months), 1 - (span.days ?? 0));
}

/**
 * Splits `start` through `end` into requests no wider than `maxWindow`,
 * newest first. Each request ends the day before the newer one starts, and
 * its width is measured back from its own end.
 */
export function collectionWindows(
  options: Readonly<{ start: CalendarDate; end: CalendarDate; maxWindow?: CollectionSpan }>,
): readonly CollectionWindow[] {
  const first = parse(options.start);
  let end = parse(options.end);
  if (first > end) throw new RangeError("A collection period must start on or before its end.");
  if (!options.maxWindow) return [{ start: options.start, end: options.end }];
  validSpan(options.maxWindow);
  const windows: CollectionWindow[] = [];
  for (;;) {
    const start = Math.max(first, spanStart(end, options.maxWindow));
    windows.push({ start: format(start), end: format(end) });
    if (start === first) return windows;
    end = addDays(start, -1);
  }
}

/** The period a declaration covers when the run's Taipei calendar date is `today`. */
export function collectionPeriod(
  options: Readonly<{ today: CalendarDate } & CollectionPeriodDeclaration>,
): CollectionPeriod {
  validSpan(options.lookBack);
  const start = format(spanStart(parse(options.today), options.lookBack));
  return {
    start,
    end: options.today,
    windows: collectionWindows({
      start,
      end: options.today,
      ...(options.maxWindow ? { maxWindow: options.maxWindow } : {}),
    }),
  };
}

/** Whether `period` covers exactly `span` ending on its end, as a provider's quick-range option does. */
export function periodSpans(period: Pick<CollectionPeriod, "start" | "end">, span: CollectionSpan): boolean {
  validSpan(span);
  return format(spanStart(parse(period.end), span)) === period.start;
}

/**
 * The Asia/Taipei calendar date of an instant. Every current source states
 * its dates in Taipei (ADR 0006), so the machine's own zone never decides
 * which day a run queries.
 */
export function taipeiToday(nowIso: string): CalendarDate {
  const instant = new Date(nowIso);
  if (!Number.isFinite(instant.getTime())) throw new RangeError(`Invalid instant: ${nowIso}`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: SOURCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
