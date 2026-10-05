import type {
  AccountKind,
  AccountRowDto,
  CurrencyAmountDto,
  DailyHistoryRowDto,
} from "../shared-ledger/types.ts";
import {
  convertToTwd,
  indexExchangeRates,
  rateOnOrBefore,
  type ExchangeRateIndex,
} from "./exchange-rate-display.ts";
import type { OverviewHoldingPriceDto, OverviewPageDto } from "./types.ts";

export type OverviewModelInput = Pick<
  OverviewPageDto,
  "importedAt" | "accounts" | "dailyHistory" | "dailyHistoryByAccount" | "exchangeRates" | "holdingPrices"
>;

export type TickerItem =
  | { kind: "fiat"; code: string; price: number; date: string; changePct: number | null }
  | { kind: "crypto"; code: string; name: string; price: number; currency: string; date: string; changePct: number | null };

/**
 * `rates-pending`: there is nothing to price yet, either because nothing has
 * synced or because held foreign currencies have no rate. `domestic-only`: the
 * user holds only TWD and no priced holdings, so there is nothing to show.
 */
export type Ticker =
  | { state: "items"; items: TickerItem[] }
  | { state: "rates-pending" }
  | { state: "domestic-only" };

export type NetWorthPoint = { date: string; value: number };

type Change = { change: number; pct: number | null };

export type NetWorthChip =
  | ({ kind: "latest"; date: string; previousDate: string; isToday: boolean } & Change)
  | ({ kind: "trailing-30" } & Change)
  | ({ kind: "since-start"; since: string } & Change);

export type NetWorth = {
  /** Current accounts converted to TWD at `valuationDate`; null without data or rates. */
  value: number | null;
  /** When the newest observation was imported. */
  asOf: string | null;
  valuationDate: string | null;
  chips: NetWorthChip[];
};

/** One calendar day; `change` is null when that day has no record to compare. */
export type DailyBar = { date: string; change: number | null };

export type ChangeReason =
  | { kind: "fx"; currency: string; pct: number }
  | { kind: "price"; symbol: string; name: string; pct: number };

export type AccountContribution = {
  account: AccountRowDto;
  change: number;
  reason: ChangeReason | null;
};

export type TodayChange =
  | { state: "insufficient" }
  | {
    state: "ready";
    date: string;
    previousDate: string;
    isToday: boolean;
    total: number;
    pct: number | null;
    rows: AccountContribution[];
    /** Accounts first recorded after `previousDate`; their balances are not change. */
    newAccountCount: number;
    /** |crypto contributions| / Σ|contributions|; null when crypto did not move. */
    cryptoShare: number | null;
  };

export type AssetCategory = "brokerage" | "crypto" | "bank" | "fund" | "foreign" | "other";

export type AssetAllocation = {
  total: number;
  valuationDate: string | null;
  slices: { category: AssetCategory; value: number; share: number }[];
  unconvertedCurrencies: string[];
};

export type LiabilityAllocation = {
  total: number;
  /** Liabilities / assets, both in TWD; null without both sides. */
  ratio: number | null;
  slices: { account: AccountRowDto; value: number; share: number }[];
  unconvertedCurrencies: string[];
};

export type OverviewModel = {
  ticker: Ticker;
  netWorth: NetWorth;
  series: NetWorthPoint[];
  dailyBars: DailyBar[];
  todayChange: TodayChange;
  assetAllocation: AssetAllocation;
  liabilityAllocation: LiabilityAllocation;
  /** History rows converted to TWD at each date's rate, for the daily detail table. */
  historyRows: DailyHistoryRowDto[];
};

export type SeriesRange = "30d" | "90d" | "all";

const DAILY_BAR_DAYS = 14;
const FIAT_ORDER = ["USD", "JPY"];
const MIN_CONTRIBUTION = 0.5;

const ASSET_CATEGORY: Record<AccountKind, AssetCategory> = {
  bank: "bank",
  foreign: "foreign",
  fund: "fund",
  brokerage: "brokerage",
  crypto: "crypto",
  "credit-card": "other",
  loan: "other",
  other: "other",
};

export function readOverview(dto: OverviewModelInput, options: { today: string }): OverviewModel {
  const rates = indexExchangeRates(dto.exchangeRates);
  const history = [...dto.dailyHistory].sort((left, right) => left.date.localeCompare(right.date));
  const series = netWorthSeries(history, rates);
  const ledger = accountLedger(dto.dailyHistoryByAccount, rates);
  const valuationDate = history.at(-1)?.date ?? (dto.accounts.length > 0 ? options.today : null);
  const assetAllocation = readAssetAllocation(dto.accounts, rates, valuationDate);
  const liabilityAllocation = readLiabilityAllocation(dto.accounts, rates, valuationDate, assetAllocation.total);
  return {
    ticker: readTicker(dto.accounts, rates, dto.holdingPrices),
    netWorth: {
      value: currentNetWorth(dto.accounts, rates, valuationDate),
      asOf: dto.importedAt,
      valuationDate,
      chips: netWorthChips(series, ledger, options.today),
    },
    series,
    dailyBars: readDailyBars(series, ledger, options.today),
    todayChange: readTodayChange(dto, series, ledger, rates, options.today),
    assetAllocation,
    liabilityAllocation,
    historyRows: convertedHistoryRows(history, series, ledger, rates),
  };
}

export function seriesInRange(series: readonly NetWorthPoint[], range: SeriesRange): NetWorthPoint[] {
  const latest = series.at(-1);
  if (!latest || range === "all") return [...series];
  const start = addDays(latest.date, range === "30d" ? -30 : -90);
  return series.filter((point) => point.date >= start);
}

export function dateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function readTicker(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  holdingPrices: readonly OverviewHoldingPriceDto[],
): Ticker {
  const foreign = [...new Set(accounts.flatMap((account) => account.amountLines.map((amount) => amount.currency)))]
    .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
    .sort(fiatOrder);
  const fiat = foreign.flatMap((currency): TickerItem[] => {
    const currencyRates = rates.get(currency) ?? [];
    const latest = currencyRates.at(-1);
    if (!latest) return [];
    const previous = currencyRates.at(-2);
    return [{
      kind: "fiat",
      code: currency,
      price: latest.twdPerUnit,
      date: latest.rateDate,
      changePct: previous ? ratioChange(latest.twdPerUnit, previous.twdPerUnit) : null,
    }];
  });
  const newestBySymbol = new Map<string, OverviewHoldingPriceDto>();
  for (const holding of holdingPrices) {
    if (holding.kind !== "crypto" || holding.cash || holding.observations.length === 0) continue;
    const current = newestBySymbol.get(holding.symbol);
    if (!current || holding.observations.at(-1)!.date > current.observations.at(-1)!.date)
      newestBySymbol.set(holding.symbol, holding);
  }
  const crypto = [...newestBySymbol.values()]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((holding): TickerItem => {
      const latest = holding.observations.at(-1)!;
      const previous = holding.observations.length > 1 ? holding.observations.at(-2)! : null;
      return {
        kind: "crypto",
        code: holding.symbol,
        name: holding.name,
        price: latest.price,
        currency: holding.currency,
        date: latest.date,
        changePct: previous ? ratioChange(latest.price, previous.price) : null,
      };
    });
  const items = [...fiat, ...crypto];
  if (items.length > 0) return { state: "items", items };
  return accounts.length === 0 || foreign.length > 0 ? { state: "rates-pending" } : { state: "domestic-only" };
}

function netWorthSeries(history: readonly DailyHistoryRowDto[], rates: ExchangeRateIndex): NetWorthPoint[] {
  return history.flatMap((row) => {
    const converted = convertToTwd(row.netAssets, row.date, rates);
    return converted ? [{ date: row.date, value: converted.value }] : [];
  });
}

function currentNetWorth(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string | null,
): number | null {
  if (!valuationDate || accounts.length === 0) return null;
  let total = 0;
  for (const account of accounts) {
    const converted = convertToTwd(account.amountLines, valuationDate, rates);
    if (!converted) return null;
    total += account.group === "liability" ? -converted.value : converted.value;
  }
  return total;
}

type AccountLedger = Readonly<{
  /** The account's carried-forward TWD value at `date`, or null before its first record. */
  valueAt(accountId: string, date: string): number | null;
  /**
   * Net worth change from `from` to `to` over the accounts recorded on both
   * dates. An account first recorded inside the span is not a change in
   * wealth, only new coverage, so it is counted in `newAccounts` instead.
   */
  change(from: string, to: string): Change & { newAccounts: string[] };
}>;

function accountLedger(
  byAccount: OverviewModelInput["dailyHistoryByAccount"],
  rates: ExchangeRateIndex,
): AccountLedger {
  const rowsByAccount = new Map(Object.entries(byAccount).map(([accountId, rows]) => [
    accountId,
    [...rows].sort((left, right) => left.date.localeCompare(right.date)),
  ]));
  const valueAt = (accountId: string, date: string): number | null => {
    const rows = rowsByAccount.get(accountId) ?? [];
    if (!rows[0] || rows[0].date > date) return null;
    return convertToTwd(carriedNet(rows, date), date, rates)?.value ?? null;
  };
  return {
    valueAt,
    change(from, to) {
      let change = 0;
      let base = 0;
      const newAccounts: string[] = [];
      for (const accountId of rowsByAccount.keys()) {
        const before = valueAt(accountId, from);
        const after = valueAt(accountId, to);
        if (after === null) continue;
        if (before === null) {
          newAccounts.push(accountId);
          continue;
        }
        change += after - before;
        base += before;
      }
      return { change, pct: base === 0 ? null : change / Math.abs(base), newAccounts };
    },
  };
}

function changeOf(ledger: AccountLedger, from: string, to: string): Change {
  const { change, pct } = ledger.change(from, to);
  return { change, pct };
}

function netWorthChips(series: readonly NetWorthPoint[], ledger: AccountLedger, today: string): NetWorthChip[] {
  const latest = series.at(-1);
  const previous = series.at(-2);
  if (!latest || !previous) return [];
  const chips: NetWorthChip[] = [{
    kind: "latest",
    date: latest.date,
    previousDate: previous.date,
    isToday: latest.date === today,
    ...changeOf(ledger, previous.date, latest.date),
  }];
  const first = series[0]!;
  const trailingStart = addDays(latest.date, -30);
  const trailingBase = series.findLast((point) => point.date <= trailingStart);
  if (trailingBase && trailingBase !== first)
    chips.push({ kind: "trailing-30", ...changeOf(ledger, trailingBase.date, latest.date) });
  chips.push({ kind: "since-start", since: first.date, ...changeOf(ledger, first.date, latest.date) });
  return chips;
}

function readDailyBars(series: readonly NetWorthPoint[], ledger: AccountLedger, today: string): DailyBar[] {
  const byDate = new Map(series.map((point, index) => [point.date, index]));
  return Array.from({ length: DAILY_BAR_DAYS }, (_, offset) => {
    const date = addDays(today, offset - DAILY_BAR_DAYS + 1);
    const index = byDate.get(date);
    const change = index === undefined || index === 0
      ? null
      : ledger.change(series[index - 1]!.date, date).change;
    return { date, change };
  });
}

function readTodayChange(
  dto: OverviewModelInput,
  series: readonly NetWorthPoint[],
  ledger: AccountLedger,
  rates: ExchangeRateIndex,
  today: string,
): TodayChange {
  const latest = series.at(-1);
  const previous = series.at(-2);
  if (!latest || !previous) return { state: "insufficient" };
  const total = ledger.change(previous.date, latest.date);
  const rows: AccountContribution[] = [];
  for (const account of dto.accounts) {
    const before = ledger.valueAt(account.id, previous.date);
    const after = ledger.valueAt(account.id, latest.date);
    if (before === null || after === null) continue;
    const change = after - before;
    if (Math.abs(change) < MIN_CONTRIBUTION) continue;
    const accountRows = dto.dailyHistoryByAccount[account.id] ?? [];
    const amounts = [...carriedNet(accountRows, previous.date), ...carriedNet(accountRows, latest.date)];
    rows.push({
      account,
      change,
      reason: changeReason(account, dto.holdingPrices, amounts, previous.date, latest.date, rates),
    });
  }
  rows.sort((left, right) => Math.abs(right.change) - Math.abs(left.change));
  const moved = rows.reduce((sum, row) => sum + Math.abs(row.change), 0);
  const cryptoMoved = rows
    .filter((row) => row.account.kind === "crypto")
    .reduce((sum, row) => sum + Math.abs(row.change), 0);
  return {
    state: "ready",
    date: latest.date,
    previousDate: previous.date,
    isToday: latest.date === today,
    total: total.change,
    pct: total.pct,
    rows,
    newAccountCount: total.newAccounts.length,
    cryptoShare: cryptoMoved > 0 && moved > 0 ? cryptoMoved / moved : null,
  };
}

/** Per-account rows exist only on dates the account changed; the latest row on or before `date` still holds. */
function carriedNet(rows: readonly DailyHistoryRowDto[], date: string): CurrencyAmountDto[] {
  let carried: DailyHistoryRowDto | undefined;
  for (const row of rows) {
    if (row.date > date) break;
    carried = row;
  }
  return carried?.netAssets ?? [];
}

/**
 * A reason is shown only when it is a provable fact about the two dates: the
 * implied price of an account's single holding, or the rate of an account's
 * single foreign currency.
 */
function changeReason(
  account: AccountRowDto,
  holdingPrices: readonly OverviewHoldingPriceDto[],
  amounts: readonly CurrencyAmountDto[],
  previousDate: string,
  latestDate: string,
  rates: ExchangeRateIndex,
): ChangeReason | null {
  if (account.group === "investment") {
    const holdings = holdingPrices.filter((holding) => holding.accountId === account.id && !holding.cash);
    if (holdings.length !== 1) return null;
    const holding = holdings[0]!;
    const before = holding.observations.findLast((observation) => observation.date <= previousDate);
    const after = holding.observations.findLast((observation) => observation.date <= latestDate);
    if (!before || !after || before === after) return null;
    const pct = ratioChange(after.price, before.price);
    return pct === null || pct === 0 ? null : { kind: "price", symbol: holding.symbol, name: holding.name, pct };
  }
  const currencies = [...new Set(amounts.map((amount) => amount.currency))];
  if (currencies.length !== 1 || currencies[0] === "TWD") return null;
  const currency = currencies[0]!;
  const before = rateOnOrBefore(rates, currency, previousDate);
  const after = rateOnOrBefore(rates, currency, latestDate);
  if (!before || !after) return null;
  const pct = ratioChange(after.twdPerUnit, before.twdPerUnit);
  return pct === null || pct === 0 ? null : { kind: "fx", currency, pct };
}

function readAssetAllocation(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string | null,
): AssetAllocation {
  const byCategory = new Map<AssetCategory, number>();
  const unconverted = new Set<string>();
  for (const account of accounts) {
    if (account.group === "liability" || !valuationDate) continue;
    const value = convertAccount(account, rates, valuationDate, unconverted);
    if (value === null) continue;
    const category = ASSET_CATEGORY[account.kind];
    byCategory.set(category, (byCategory.get(category) ?? 0) + value);
  }
  const positive = [...byCategory].filter(([, value]) => value > 0);
  const total = positive.reduce((sum, [, value]) => sum + value, 0);
  return {
    total,
    valuationDate,
    slices: positive
      .map(([category, value]) => ({ category, value, share: value / total }))
      .sort((left, right) => right.value - left.value),
    unconvertedCurrencies: [...unconverted].sort(),
  };
}

function readLiabilityAllocation(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string | null,
  assetTotal: number,
): LiabilityAllocation {
  const unconverted = new Set<string>();
  const owed = accounts.flatMap((account) => {
    if (account.group !== "liability" || !valuationDate) return [];
    const value = convertAccount(account, rates, valuationDate, unconverted);
    return value !== null && value > 0 ? [{ account, value }] : [];
  });
  const total = owed.reduce((sum, row) => sum + row.value, 0);
  return {
    total,
    ratio: total > 0 && assetTotal > 0 ? total / assetTotal : null,
    slices: owed
      .map((row) => ({ ...row, share: row.value / total }))
      .sort((left, right) => right.value - left.value),
    unconvertedCurrencies: [...unconverted].sort(),
  };
}

function convertAccount(
  account: AccountRowDto,
  rates: ExchangeRateIndex,
  date: string,
  unconverted: Set<string>,
): number | null {
  const converted = convertToTwd(account.amountLines, date, rates);
  if (converted) return converted.value;
  for (const amount of account.amountLines)
    if (!rateOnOrBefore(rates, amount.currency, date)) unconverted.add(amount.currency);
  return null;
}

function convertedHistoryRows(
  history: readonly DailyHistoryRowDto[],
  series: readonly NetWorthPoint[],
  ledger: AccountLedger,
  rates: ExchangeRateIndex,
): DailyHistoryRowDto[] {
  const seriesIndex = new Map(series.map((point, index) => [point.date, index]));
  return history.map((row) => {
    const net = convertToTwd(row.netAssets, row.date, rates);
    const assets = convertToTwd(row.assets, row.date, rates);
    const liabilities = convertToTwd(row.liabilities, row.date, rates);
    if (!net || !assets || !liabilities)
      return { ...row, exchangeRateDates: [], exchangeRateMissing: true };
    const index = seriesIndex.get(row.date) ?? 0;
    const previous = index > 0 ? series[index - 1]! : null;
    return {
      ...row,
      netAssets: twd(net.value),
      dailyChange: previous ? twd(ledger.change(previous.date, row.date).change) : [],
      assets: twd(assets.value),
      liabilities: twd(liabilities.value),
      exchangeRateDates: [...new Set([...net.rateDates, ...assets.rateDates, ...liabilities.rateDates])].sort(),
      exchangeRateMissing: false,
    };
  });
}

function twd(value: number): CurrencyAmountDto[] {
  return [{ currency: "TWD", value }];
}

function ratioChange(value: number, base: number): number | null {
  return base === 0 ? null : value / base - 1;
}

function fiatOrder(left: string, right: string): number {
  const leftIndex = FIAT_ORDER.indexOf(left);
  const rightIndex = FIAT_ORDER.indexOf(right);
  return (leftIndex < 0 ? FIAT_ORDER.length : leftIndex) - (rightIndex < 0 ? FIAT_ORDER.length : rightIndex)
    || left.localeCompare(right);
}
