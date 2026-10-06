import { convertToTwd, indexExchangeRates } from "../shared-money/exchange-rates.ts";
import {
  accountLedger,
  accountShares,
  readAssetAllocation,
  TRAILING_DAYS,
  trailingChange,
  valuationDateFor,
  type AssetAllocation,
  type SpanChange,
} from "../shared-ledger/twd-valuation.ts";
import type { AssetsPageDto } from "./types.ts";

export type AssetsSummaryInput = Pick<AssetsPageDto, "accounts" | "dailyHistory" | "dailyHistoryByAccount" | "exchangeRates">;

/**
 * `empty`: no asset account exists. `ready` holds the converted total; its
 * `trailing` is null until history reaches back 30 days, and its slices omit
 * accounts in `unconvertedCurrencies`.
 */
export type AssetsSummary =
  | { state: "empty" }
  | {
    state: "ready";
    total: number;
    valuationDate: string;
    trailing: SpanChange | null;
    slices: AssetAllocation["slices"];
    unconvertedCurrencies: string[];
    /** Each account's share of the converted total, for the table. */
    shares: ReadonlyMap<string, number>;
  };

export function readAssetsSummary(input: AssetsSummaryInput, options: { today: string }): AssetsSummary {
  const valuationDate = valuationDateFor(input.dailyHistory, input.accounts, options.today);
  if (input.accounts.length === 0 || !valuationDate) return { state: "empty" };
  const rates = indexExchangeRates(input.exchangeRates);
  const allocation = readAssetAllocation(input.accounts, rates, valuationDate);
  const ownIds = new Set(input.accounts.map((account) => account.id));
  const ledger = accountLedger(
    Object.fromEntries(Object.entries(input.dailyHistoryByAccount).filter(([id]) => ownIds.has(id))),
    rates,
  );
  const dates = input.dailyHistory
    .filter((row) => convertToTwd(row.assets, row.date, rates))
    .map((row) => row.date)
    .sort();
  return {
    state: "ready",
    total: allocation.total,
    valuationDate,
    trailing: trailingChange(dates, ledger, TRAILING_DAYS),
    slices: allocation.slices,
    unconvertedCurrencies: allocation.unconvertedCurrencies,
    shares: accountShares(input.accounts, rates, valuationDate),
  };
}
