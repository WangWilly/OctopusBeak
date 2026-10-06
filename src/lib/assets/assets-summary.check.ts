import assert from "node:assert/strict";
import test from "node:test";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, ExchangeRateDto } from "../shared-ledger/types.ts";
import { readAssetsSummary, type AssetsSummaryInput } from "./assets-summary.ts";

function account(id: string, kind: AccountRowDto["kind"], amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: "Account",
    group: ["fund", "brokerage", "crypto"].includes(kind) ? "investment" : "asset",
    kind,
    typeLabel: kind,
    amountLines,
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
  };
}

function row(date: string, amounts: CurrencyAmountDto[]): DailyHistoryRowDto {
  return { date, netAssets: amounts, dailyChange: [], assets: amounts, liabilities: [], accountChanges: [], positionCount: 0 };
}

const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];
const usd = (value: number): CurrencyAmountDto[] => [{ currency: "USD", value }];
const rate = (rateDate: string, currency: string, twdPerUnit: number): ExchangeRateDto => ({ rateDate, currency, twdPerUnit });

function input(overrides: Partial<AssetsSummaryInput>): AssetsSummaryInput {
  return { accounts: [], dailyHistory: [], dailyHistoryByAccount: {}, exchangeRates: [], ...overrides };
}

test("no asset account reads as empty, not as a zero total", () => {
  assert.deepEqual(readAssetsSummary(input({}), { today: "2026-10-05" }), { state: "empty" });
});

test("the total converts every account at the valuation date's rate and splits by kind", () => {
  const summary = readAssetsSummary(input({
    accounts: [account("bank", "bank", twd(1000)), account("usd", "foreign", usd(100))],
    dailyHistory: [row("2026-10-04", twd(1000))],
    exchangeRates: [rate("2026-10-01", "USD", 30), rate("2026-10-05", "USD", 99)],
  }), { today: "2026-10-05" });
  assert.equal(summary.state, "ready");
  if (summary.state !== "ready") return;
  assert.equal(summary.valuationDate, "2026-10-04", "balances are valued at the newest history date");
  assert.equal(summary.total, 4000, "USD uses the rate on or before 10-04, not the later one");
  assert.deepEqual(summary.slices.map((slice) => [slice.category, slice.value, slice.share]), [
    ["foreign", 3000, 0.75],
    ["bank", 1000, 0.25],
  ]);
  assert.equal(summary.shares.get("usd"), 0.75, "a foreign-currency account gets its converted share, not 0%");
  assert.equal(summary.twdValues.get("usd"), 3000, "positions read the account's value in TWD");
});

test("an account without a rate is left out of the total and named", () => {
  const summary = readAssetsSummary(input({
    accounts: [account("bank", "bank", twd(1000)), account("jpy", "foreign", [{ currency: "JPY", value: 5000 }])],
    dailyHistory: [row("2026-10-04", twd(1000))],
  }), { today: "2026-10-05" });
  assert.equal(summary.state === "ready" && summary.total, 1000);
  assert.deepEqual(summary.state === "ready" && summary.unconvertedCurrencies, ["JPY"]);
  assert.equal(summary.state === "ready" && summary.shares.has("jpy"), false);
});

test("the 30-day change counts only accounts recorded on both dates, each at its own date's rate", () => {
  const usdHistory = [row("2026-09-01", usd(100)), row("2026-10-05", usd(100))];
  const bankHistory = [row("2026-10-05", twd(50_000))];
  const summary = readAssetsSummary(input({
    accounts: [account("usd", "foreign", usd(100)), account("bank", "bank", twd(50_000))],
    dailyHistory: [row("2026-09-01", usd(100)), row("2026-10-05", [...usd(100), ...twd(50_000)])],
    dailyHistoryByAccount: { usd: usdHistory, bank: bankHistory },
    exchangeRates: [rate("2026-09-01", "USD", 30), rate("2026-10-05", "USD", 31)],
  }), { today: "2026-10-05" });
  assert.equal(summary.state, "ready");
  if (summary.state !== "ready") return;
  assert.deepEqual(summary.trailing, {
    from: "2026-09-01",
    to: "2026-10-05",
    change: 100,
    pct: 100 / 3000,
    newAccounts: ["bank"],
  });
});

test("history shorter than 30 days has no 30-day change", () => {
  const history = [row("2026-09-20", twd(900)), row("2026-10-05", twd(1000))];
  const summary = readAssetsSummary(input({
    accounts: [account("bank", "bank", twd(1000))],
    dailyHistory: history,
    dailyHistoryByAccount: { bank: history },
  }), { today: "2026-10-05" });
  assert.equal(summary.state === "ready" && summary.trailing, null);
});
