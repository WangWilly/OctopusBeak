import {
  accountShares,
  accountTwdValues,
  readAssetAllocation,
  type AssetAllocation,
  type SpanChange,
  readSideValuation,
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
    /** Each account's converted value, for its positions. */
    twdValues: ReadonlyMap<string, number>;
    includesPreview: boolean;
  };

export function readAssetsSummary(input: AssetsSummaryInput, options: { today: string }): AssetsSummary {
  const side = readSideValuation(input, "assets", options.today);
  if (!side) return { state: "empty" };
  const { valuationDate, rates, trailing } = side;
  const allocation = readAssetAllocation(input.accounts, rates, valuationDate);
  return {
    state: "ready",
    total: allocation.total,
    valuationDate,
    trailing,
    slices: allocation.slices,
    unconvertedCurrencies: allocation.unconvertedCurrencies,
    shares: accountShares(input.accounts, rates, valuationDate),
    twdValues: accountTwdValues(input.accounts, rates, valuationDate),
    includesPreview: allocation.includesPreview || (trailing?.includesPreview ?? false),
  };
}
