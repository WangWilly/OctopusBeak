import assert from "node:assert/strict";
import type {
  AccountKind,
  AccountRowDto,
  DailyHistoryRowDto,
} from "$lib/shared-ledger/types.ts";
import {
  buildStackedBalanceChartData,
  selectStackedBalanceChartSeries,
} from "./stacked-balance-chart-data.ts";

const accounts = [
  account("bank-a", "Bank A", "bank", 100),
  account("bank-b", "Bank B", "bank", 200),
  account("fund-a", "Fund A", "fund", 300),
  account("empty-brokerage", "Empty Brokerage", "brokerage", 0),
  account("card-a", "Card A", "credit-card", 400),
  account("loan-a", "Loan A", "loan", 500),
];

const dailyHistoryByAccount = {
  "bank-a": [row("2026-06-24", 100, 0), row("2026-06-25", 110, 0)],
  "bank-b": [row("2026-06-24", 200, 0), row("2026-06-25", 220, 0)],
  "fund-a": [row("2026-06-24", 300, 0), row("2026-06-25", 330, 0)],
  "empty-brokerage": [row("2026-06-24", 0, 0), row("2026-06-25", 0, 0)],
  "card-a": [row("2026-06-24", 0, -400), row("2026-06-25", 0, -410)],
  "loan-a": [row("2026-06-24", 0, 500), row("2026-06-25", 0, 520)],
} satisfies Record<string, DailyHistoryRowDto[]>;

const allAssets = buildStackedBalanceChartData({
  accounts,
  dailyHistoryByAccount,
  filter: "all",
  currency: "TWD",
  mode: "asset",
});
assert.deepEqual(allAssets.series.map((series) => series.key), ["bank", "fund"]);
assert.deepEqual(allAssets.dates, ["2026-06-24", "2026-06-25"]);
assert.equal(allAssets.totals[0].time, Date.parse("2026-06-24T00:00:00.000Z"));
assert.deepEqual(allAssets.series[0].data.map((point) => point.value), [300, 330]);
assert.deepEqual(allAssets.totals.map((point) => point.value), [600, 660]);

const fundOnly = selectStackedBalanceChartSeries(allAssets, ["fund"]);
assert.deepEqual(fundOnly.series.map((series) => series.key), ["fund"]);
assert.deepEqual(fundOnly.totals.map((point) => point.value), [300, 330]);

const allSelected = selectStackedBalanceChartSeries(allAssets, []);
assert.deepEqual(allSelected.series.map((series) => series.key), ["bank", "fund"]);
assert.deepEqual(allSelected.totals.map((point) => point.value), [600, 660]);

const bankAssets = buildStackedBalanceChartData({
  accounts,
  dailyHistoryByAccount,
  filter: "bank",
  currency: "TWD",
  mode: "asset",
});
assert.deepEqual(bankAssets.series.map((series) => series.label), ["Bank A", "Bank B"]);
assert.deepEqual(bankAssets.series[1].data.map((point) => point.value), [200, 220]);

const usdAssets = buildStackedBalanceChartData({
  accounts,
  dailyHistoryByAccount,
  filter: "all",
  currency: "USD",
  mode: "asset",
});
assert.deepEqual(usdAssets.series, []);
assert.deepEqual(usdAssets.totals.map((point) => point.value), [0, 0]);

const allLiabilities = buildStackedBalanceChartData({
  accounts,
  dailyHistoryByAccount,
  filter: "all",
  currency: "TWD",
  mode: "liability",
});
assert.deepEqual(allLiabilities.series.map((series) => series.key), ["credit-card", "loan"]);
assert.deepEqual(allLiabilities.series[0].data.map((point) => point.value), [400, 410]);
assert.deepEqual(allLiabilities.totals.map((point) => point.value), [900, 930]);

const sameDayCaptures = buildStackedBalanceChartData({
  accounts: [accounts[4]!],
  dailyHistoryByAccount: {
    "card-a": [
      row("2026-07-12", 0, 180, "2026-07-12T10:00:00.000Z"),
      row("2026-07-12", 0, 120, "2026-07-12T08:00:00.000Z"),
    ],
  },
  filter: "all",
  currency: "TWD",
  mode: "liability",
});
assert.deepEqual(sameDayCaptures.dates, ["2026-07-12T08:00:00.000Z", "2026-07-12T10:00:00.000Z"]);
assert.deepEqual(sameDayCaptures.series[0]?.data.map((point) => [point.dateLabel, point.time, point.value]), [
  ["2026-07-12 08:00", Date.parse("2026-07-12T08:00:00.000Z"), 120],
  ["2026-07-12 10:00", Date.parse("2026-07-12T10:00:00.000Z"), 180],
]);

function account(id: string, label: string, kind: AccountKind, value: number): AccountRowDto {
  const group =
    kind === "credit-card" || kind === "loan" || kind === "other"
      ? "liability"
      : kind === "fund" || kind === "brokerage" || kind === "crypto"
        ? "investment"
        : "asset";
  return {
    id,
    label,
    institution: label,
    product: label,
    group,
    kind,
    typeLabel: kind,
    amountLines: [{ currency: "TWD", value }],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
  };
}

function row(date: string, assets: number, liabilities: number, pointAt?: string): DailyHistoryRowDto {
  return {
    date,
    ...(pointAt ? { pointAt } : {}),
    netAssets: [{ currency: "TWD", value: assets - Math.abs(liabilities) }],
    dailyChange: [{ currency: "TWD", value: 0 }],
    assets: [{ currency: "TWD", value: assets }],
    liabilities: [{ currency: "TWD", value: liabilities }],
    accountChanges: [],
    positionCount: 0,
  };
}
