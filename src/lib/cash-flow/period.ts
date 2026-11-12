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

/**
 * The period the person chose. Two presets can give the same range, such as
 * 本月 and 近 30 天 on the 30th, so the choice is kept, never read back from the range.
 */
export type CashFlowPeriodChoice = CashFlowPreset | "custom";

/**
 * What a range applied from the picker is: the quick choice the person tapped
 * when a preset rolls the same way, otherwise a custom range. A fixed range
 * such as 上個月, or a quick choice with no matching preset, stays custom.
 */
export function quickChoice(preset: CashFlowQuickPreset | null): CashFlowPeriodChoice {
  return preset === "week" || preset === "month" ? preset : "custom";
}

/** The quick choice a picker opens with: the page's own rolling preset, if the picker lists it. */
export function pickerQuick(choice: CashFlowPeriodChoice): CashFlowQuickPreset | null {
  return choice === "week" || choice === "month" ? choice : null;
}

/** What a picker applies: the page's own choice when the person changed nothing, so 近 30 天 keeps rolling too. */
export function pickerChoice(current: CashFlowPeriodChoice, picked: CashFlowQuickPreset | null, touched: boolean): CashFlowPeriodChoice {
  return touched ? quickChoice(picked) : current;
}

/** The chosen preset's range on `today`; a custom range stays as it is. */
export function rollRange(range: CashFlowRange, choice: CashFlowPeriodChoice, today: string): CashFlowRange {
  return choice === "custom" ? range : quickRange(choice, today);
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
