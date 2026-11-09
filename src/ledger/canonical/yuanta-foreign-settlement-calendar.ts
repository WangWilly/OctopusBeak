import {
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-contract.ts";

/**
 * Yuanta settles overseas (複委託) trades against the foreign-currency
 * deposit on Taiwan business days, so the calendar is the Taiwan government
 * office calendar (行政院人事行政總處 政府行政機關辦公日曆表), not an
 * exchange calendar. Each year lists the weekdays it closes; a year with a
 * Saturday make-up workday would also need that day, and 115年 and 116年
 * have none.
 *
 * v2 adds 2027 and the 2026 holidays the 2025 statute added (9/28, 10/26,
 * 12/25), which v1 missed.
 */
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_CONTRACT_VERSION =
  "yuanta/foreign-settlement/calendar-v2" as const;

const TAIWAN_WEEKDAY_CLOSURES: Readonly<Record<number, readonly string[]>> = {
  2026: [
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
    "2026-02-20", "2026-02-27", "2026-04-03", "2026-04-06", "2026-05-01",
    "2026-06-19", "2026-09-25", "2026-09-28", "2026-10-09", "2026-10-26",
    "2026-12-25",
  ],
  2027: [
    "2027-01-01", "2027-02-04", "2027-02-05", "2027-02-08", "2027-02-09",
    "2027-02-10", "2027-03-01", "2027-04-05", "2027-04-06", "2027-04-30",
    "2027-06-09", "2027-09-15", "2027-09-28", "2027-10-11", "2027-10-25",
    "2027-12-24", "2027-12-31",
  ],
};

type SettlementCalendar = Readonly<{
  contractVersion: typeof YUANTA_FOREIGN_SETTLEMENT_CALENDAR_CONTRACT_VERSION;
  start: string;
  end: string;
  closures: ReadonlySet<string>;
}>;

function calendarFrom(years: Readonly<Record<number, readonly string[]>>): SettlementCalendar {
  const covered = Object.keys(years).map(Number).sort((left, right) => left - right);
  for (const [index, year] of covered.entries())
    if (index > 0 && year !== covered[index - 1]! + 1)
      throw new Error("Yuanta settlement calendar years must be contiguous.");
  return {
    contractVersion: YUANTA_FOREIGN_SETTLEMENT_CALENDAR_CONTRACT_VERSION,
    start: `${covered[0]}-01-01`,
    end: `${covered.at(-1)}-12-31`,
    closures: new Set(Object.values(years).flat()),
  };
}

type MarketRule = Readonly<{
  market: typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY;
  businessDays: Readonly<Record<"buy" | "sell", number>>;
  calendar: SettlementCalendar;
}>;

const MARKET_RULES: Readonly<Record<string, MarketRule>> = {
  [YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION]: {
    market: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
    businessDays: { buy: 1, sell: 2 },
    calendar: calendarFrom(TAIWAN_WEEKDAY_CLOSURES),
  },
};

/**
 * The settlement walk reached a day the calendar does not cover. Before the
 * coverage it is history the contract never claimed; after it the calendar is
 * stale and must be extended from the next published government calendar.
 */
export class YuantaSettlementCalendarNotCoveredError extends Error {
  override readonly name = "YuantaSettlementCalendarNotCoveredError";
  readonly date: string;
  readonly coverage: Readonly<{ contractVersion: string; start: string; end: string }>;

  constructor(date: string, calendar: SettlementCalendar) {
    super(`Yuanta settlement calendar ${calendar.contractVersion} covers ${calendar.start}..${calendar.end}, not ${date}.`);
    this.date = date;
    this.coverage = { contractVersion: calendar.contractVersion, start: calendar.start, end: calendar.end };
  }

  get beforeCoverage(): boolean {
    return this.date < this.coverage.start;
  }
}

export function yuantaForeignSettlementEffectiveOn(input: Readonly<{
  settlementMarket: string;
  settlementMarketContractVersion: string;
  effectiveOn: string;
  action: "buy" | "sell";
}>): string {
  const rule = Object.hasOwn(MARKET_RULES, input.settlementMarketContractVersion)
    ? MARKET_RULES[input.settlementMarketContractVersion]!
    : undefined;
  if (!rule || rule.market !== input.settlementMarket)
    throw new Error(`Yuanta settlement market contract ${input.settlementMarketContractVersion} has no ${input.settlementMarket} rule.`);
  const { calendar } = rule;
  const date = new Date(`${input.effectiveOn}T00:00:00Z`);
  let counted = 0;
  while (counted < rule.businessDays[input.action]) {
    date.setUTCDate(date.getUTCDate() + 1);
    const candidate = date.toISOString().slice(0, 10);
    if (candidate < calendar.start || candidate > calendar.end)
      throw new YuantaSettlementCalendarNotCoveredError(candidate, calendar);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !calendar.closures.has(candidate)) counted += 1;
  }
  return date.toISOString().slice(0, 10);
}
