import assert from "node:assert/strict";
import test from "node:test";
import type { DailyHistoryRowDto } from "../../lib/shared-ledger/types.ts";
import type { PGliteDailyHistory } from "./daily-history.ts";
import {
  countableWithRates,
  exactFromDecimal,
  previewAccountRow,
  previewBalanceSeries,
  withPreviewHistory,
  type PreviewBalanceSeries,
} from "./preview-overview.ts";

const twd = (coefficient: string, scale = 0) => ({
  currency: "TWD",
  value: Number(coefficient) / 10 ** scale,
  exact: { coefficient, scale },
});

function canonicalRow(date: string, assets: string, liabilities: string, label: string): DailyHistoryRowDto {
  return {
    date,
    netAssets: [twd(String(Number(assets) - Number(liabilities)))],
    dailyChange: [],
    assets: [twd(assets)],
    liabilities: [twd(liabilities)],
    accountChanges: [label],
    positionCount: 2,
  };
}

const canonical: PGliteDailyHistory = {
  dailyHistory: [
    canonicalRow("2026-10-01", "1000", "200", "Cathay"),
    canonicalRow("2026-10-05", "1500", "200", "Cathay"),
  ],
  dailyHistoryByAccount: { cathay: [canonicalRow("2026-10-01", "1000", "0", "Cathay")] },
};

const savings: PreviewBalanceSeries = {
  accountId: "preview:a",
  label: "Preview savings",
  points: [
    { date: "2026-10-03", currency: "TWD", exact: { coefficient: "12345", scale: 1 } },
    { date: "2026-10-05", currency: "TWD", exact: { coefficient: "500", scale: 0 } },
  ],
};

const always = () => true;

test("without preview accounts the canonical history is returned unchanged", () => {
  assert.equal(withPreviewHistory(canonical, [], always), canonical);
});

test("preview dates join the canonical dates and carry the newest canonical total forward", () => {
  const merged = withPreviewHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistory.map((row) => row.date), ["2026-10-01", "2026-10-03", "2026-10-05"]);
  const [first, carried, both] = merged.dailyHistory;
  assert.deepEqual(first!.assets, [twd("1000")]);
  assert.equal(first!.includesPreview, undefined);
  assert.deepEqual(carried!.assets, [twd("22345", 1)], "1000 carried from 10-01 plus 1234.5");
  assert.deepEqual(carried!.netAssets, [twd("20345", 1)]);
  assert.deepEqual(carried!.liabilities, [twd("200")]);
  assert.equal(carried!.positionCount, 2);
  assert.deepEqual(carried!.accountChanges, ["Preview savings"]);
  assert.equal(carried!.includesPreview, true);
  assert.deepEqual(both!.assets, [twd("2000")]);
  assert.deepEqual(both!.accountChanges, ["Cathay", "Preview savings"]);
});

test("daily change is the difference from the previous merged row, exactly", () => {
  const merged = withPreviewHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistory.map((row) => row.dailyChange), [
    [],
    [twd("12345", 1)],
    [twd("-2345", 1)],
  ]);
});

test("a preview balance before any canonical row stands alone", () => {
  const merged = withPreviewHistory({ dailyHistory: [], dailyHistoryByAccount: {} }, [savings], always);
  assert.deepEqual(merged.dailyHistory[0]!.assets, [twd("12345", 1)]);
  assert.deepEqual(merged.dailyHistory[0]!.liabilities, []);
  assert.equal(merged.dailyHistory[0]!.positionCount, 0);
});

test("a preview balance without a rate is left out instead of dropping the date", () => {
  const usd: PreviewBalanceSeries = {
    accountId: "preview:u",
    label: "Preview USD",
    points: [{ date: "2026-10-03", currency: "USD", exact: { coefficient: "100", scale: 0 } }],
  };
  const merged = withPreviewHistory(canonical, [usd], countableWithRates([
    { rateDate: "2026-10-04", currency: "USD", twdPerUnit: 32, source: "test", fetchedAt: "2026-10-04T00:00:00Z" },
  ]));
  const byDate = new Map(merged.dailyHistory.map((row) => [row.date, row]));
  assert.deepEqual(byDate.get("2026-10-03")!.assets, [twd("1000")]);
  assert.equal(byDate.get("2026-10-03")!.includesPreview, undefined);
  assert.deepEqual(byDate.get("2026-10-05")!.assets.map((line) => line.currency), ["TWD", "USD"]);
  assert.equal(byDate.get("2026-10-05")!.includesPreview, true);
});

test("each preview account gets its own rows on its observation dates", () => {
  const merged = withPreviewHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistoryByAccount.cathay, canonical.dailyHistoryByAccount.cathay);
  assert.deepEqual(merged.dailyHistoryByAccount["preview:a"]!.map((row) => [row.date, row.netAssets, row.includesPreview]), [
    ["2026-10-03", [twd("12345", 1)], true],
    ["2026-10-05", [twd("500")], true],
  ]);
});

test("the series prefers current balances and keeps each date's newest observation", () => {
  const [series] = previewBalanceSeries([{
    previewAccountId: "a",
    displayLabel: "Preview savings",
    observations: [
      { kind: "available", amount: "9", currency: "TWD", observedAt: { at: "2026-10-03T09:00:00Z", source: "reported" } },
      { kind: "current", amount: "1", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } },
      { kind: "current", amount: "2", currency: "TWD", observedAt: { at: "2026-10-03T05:00:00Z", source: "reported" } },
    ],
  }]);
  assert.deepEqual(series!.points, [{ date: "2026-10-03", currency: "TWD", exact: { coefficient: "2", scale: 0 } }]);
});

test("a preview account row keeps the source amount exact and is namespaced away from canonical ids", () => {
  assert.deepEqual(exactFromDecimal("-0.50"), { coefficient: "-50", scale: 2 });
  const row = previewAccountRow({
    previewAccountId: "abc",
    sourceId: "synthetic",
    institution: "bank-017",
    product: "deposit",
    displayLabel: "Preview USD",
    currency: "USD",
    type: "depository",
    lastCollectedAt: "2026-10-15T01:00:00Z",
    latestBalance: { kind: "current", amount: "1234.50", currency: "USD", observedAt: { at: "2026-10-14T23:00:00Z", source: "collection-time" } },
  }, []);
  assert.equal(row.id, "preview:abc");
  assert.equal(row.canonicalAccountId, undefined);
  assert.deepEqual([row.group, row.kind], ["asset", "foreign"]);
  assert.deepEqual(row.amountLines, [{ currency: "USD", value: 1234.5, exact: { coefficient: "123450", scale: 2 } }]);
  assert.equal(row.lastUpdated, "2026-10-14");
  assert.deepEqual(row.preview?.balanceTime, { at: "2026-10-14T23:00:00Z", source: "collection-time" });
});
