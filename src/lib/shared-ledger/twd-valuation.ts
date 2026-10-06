import { convertToTwd, rateOnOrBefore, type ExchangeRateIndex } from "../shared-money/exchange-rates.ts";
import type { AccountKind, AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto } from "./types.ts";

export type Change = { change: number; pct: number | null };

/** A change between two history dates over the accounts recorded on both. */
export type SpanChange = Change & { from: string; to: string; newAccounts: string[] };

export type AccountLedger = Readonly<{
  /** The account's carried-forward TWD value at `date`, or null before its first record. */
  valueAt(accountId: string, date: string): number | null;
  /**
   * Net worth change from `from` to `to` over the accounts recorded on both
   * dates. An account first recorded inside the span is not a change in
   * wealth, only new coverage, so it is counted in `newAccounts` instead.
   */
  change(from: string, to: string): Change & { newAccounts: string[] };
}>;

export const TRAILING_DAYS = 30;

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

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Current balances are valued at the newest history date, or today before any history exists. */
export function valuationDateFor(
  history: readonly Pick<DailyHistoryRowDto, "date">[],
  accounts: readonly AccountRowDto[],
  today: string,
): string | null {
  const latest = history.reduce<string | null>((max, row) => (max === null || row.date > max ? row.date : max), null);
  return latest ?? (accounts.length > 0 ? today : null);
}

export function accountLedger(
  byAccount: Readonly<Record<string, readonly DailyHistoryRowDto[]>>,
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

/**
 * The change over the trailing `days` up to the newest of `dates`, measured
 * from the newest date at least `days` earlier. Null when history is shorter.
 */
export function trailingChange(dates: readonly string[], ledger: AccountLedger, days: number): SpanChange | null {
  const to = dates.at(-1);
  if (!to) return null;
  const start = addDays(to, -days);
  const from = dates.findLast((date) => date <= start);
  return from ? { from, to, ...ledger.change(from, to) } : null;
}

/** Per-account rows exist only on dates the account changed; the latest row on or before `date` still holds. */
export function carriedNet(rows: readonly DailyHistoryRowDto[], date: string): CurrencyAmountDto[] {
  let carried: DailyHistoryRowDto | undefined;
  for (const row of rows) {
    if (row.date > date) break;
    carried = row;
  }
  return carried?.netAssets ?? [];
}

export function readAssetAllocation(
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

export function readLiabilityAllocation(
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

/**
 * Each account's share of the positive converted total of `accounts`. An
 * account without a rate for every currency it holds has no share.
 */
export function accountShares(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string | null,
): ReadonlyMap<string, number> {
  const values = accountTwdValues(accounts, rates, valuationDate);
  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  return new Map([...values].map(([id, value]) => [id, value / total]));
}

/** Each available account's positive value in TWD, when every currency it holds has a rate. */
export function accountTwdValues(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string | null,
): ReadonlyMap<string, number> {
  if (!valuationDate) return new Map();
  return new Map(accounts.flatMap((account) => {
    if (account.valueAvailability !== "available") return [];
    const value = convertAccount(account, rates, valuationDate, new Set());
    return value !== null && value > 0 ? [[account.id, value] as const] : [];
  }));
}

export function convertAccount(
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
