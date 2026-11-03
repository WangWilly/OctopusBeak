import {
  accountShares,
  accountTwdValues,
  readAssetAllocation,
  type AssetAllocation,
  type SpanChange,
  readSideValuation,
} from "../shared-ledger/twd-valuation.ts";
import { mergeProvenance, NO_PROVENANCE, type Provenance } from "../shared-ledger/provenance.ts";
import type { AssetsPageDto } from "./types.ts";

export type AssetsSummaryInput = Pick<
  AssetsPageDto,
  "valuationDate" | "accounts" | "dailyHistory" | "dailyHistoryByAccount" | "exchangeRates"
>;

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
    /** A verified account has no rate, so `total` is not a complete TWD figure. */
    incomplete: boolean;
    /** Each account's share of the converted total, for the table. */
    shares: ReadonlyMap<string, number>;
    /** Each account's converted value, for its positions. */
    twdValues: ReadonlyMap<string, number>;
    /** The origins the total and its trailing change count. */
    provenance: Provenance;
    totalProvenance: Provenance;
  };

export function readAssetsSummary(input: AssetsSummaryInput): AssetsSummary {
  const side = readSideValuation(input, "assets");
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
    incomplete: allocation.incomplete,
    shares: accountShares(input.accounts, rates, valuationDate),
    twdValues: accountTwdValues(input.accounts, rates, valuationDate),
    provenance: mergeProvenance(allocation.provenance, trailing?.provenance ?? NO_PROVENANCE),
    /** The total alone, for a figure that shows no change. */
    totalProvenance: allocation.provenance,
  };
}
