/** Cash flow periods: inclusive ISO date ranges that never end after today. */

export type CashFlowRange = Readonly<{ startDate: string; endDate: string }>;
export type CashFlowPreset = "week" | "month" | "last30";
export type CashFlowQuickPreset = "week" | "month" | "lastMonth" | "last90" | "year";

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
export const addDays = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);

export function rangeDays(range: CashFlowRange): number {
  return dayNumber(range.endDate) - dayNumber(range.startDate) + 1;
}

/** Monday of the week that holds `date`. */
function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function quickRange(preset: CashFlowQuickPreset | CashFlowPreset, today: string): CashFlowRange {
  switch (preset) {
    case "week":
      return { startDate: weekStart(today), endDate: today };
    case "month":
      return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
    case "last30":
      return { startDate: addDays(today, -29), endDate: today };
    case "last90":
      return { startDate: addDays(today, -89), endDate: today };
    case "year":
      return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
    case "lastMonth": {
      const end = addDays(`${today.slice(0, 7)}-01`, -1);
      return { startDate: `${end.slice(0, 7)}-01`, endDate: end };
    }
  }
}

/** Which of the page's presets a range is, or `custom`. */
export function presetOf(range: CashFlowRange, today: string): CashFlowPreset | "custom" {
  for (const preset of ["week", "month", "last30"] as const) {
    const candidate = quickRange(preset, today);
    if (candidate.startDate === range.startDate && candidate.endDate === range.endDate) return preset;
  }
  return "custom";
}

/** A preset range moved from `previousToday` to `today`; a custom range stays as it is. */
export function rollRange(range: CashFlowRange, previousToday: string, today: string): CashFlowRange {
  const preset = presetOf(range, previousToday);
  return preset === "custom" ? range : quickRange(preset, today);
}

/** A range with its end clamped to today and its ends in order. */
export function clampRange(range: CashFlowRange, today: string): CashFlowRange {
  const endDate = range.endDate > today ? today : range.endDate;
  const startDate = range.startDate > endDate ? endDate : range.startDate;
  return { startDate, endDate };
}

/** The days of a month as a Sunday-first grid; null pads the first week. */
export function monthGrid(month: string): readonly (string | null)[] {
  const first = `${month}-01`;
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const days = dayNumber(next) - dayNumber(first);
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, index) => addDays(first, index))];
}

export function shiftMonth(month: string, by: number): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

/** `10/01–10/05`, with years when the range crosses one or is not this year. */
export function rangeText(range: CashFlowRange, today: string): string {
  const sameYear = range.startDate.slice(0, 4) === range.endDate.slice(0, 4) && range.endDate.slice(0, 4) === today.slice(0, 4);
  const short = (date: string) => sameYear ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : date.replaceAll("-", "/");
  return range.startDate === range.endDate ? short(range.startDate) : `${short(range.startDate)}–${short(range.endDate)}`;
}
