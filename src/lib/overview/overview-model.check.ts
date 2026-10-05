import assert from "node:assert/strict";
import test from "node:test";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, ExchangeRateDto } from "../shared-ledger/types.ts";
import { readOverview, seriesInRange, type OverviewModelInput } from "./overview-model.ts";
import type { OverviewHoldingPriceDto } from "./types.ts";

function account(id: string, kind: AccountRowDto["kind"], amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: "Account",
    group: kind === "credit-card" || kind === "loan" ? "liability" : ["fund", "brokerage", "crypto"].includes(kind) ? "investment" : "asset",
    kind,
    typeLabel: kind,
    amountLines,
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
  };
}

function row(date: string, net: CurrencyAmountDto[]): DailyHistoryRowDto {
  return { date, netAssets: net, dailyChange: [], assets: net, liabilities: [], accountChanges: [], positionCount: 0 };
}

const usd = (value: number): CurrencyAmountDto[] => [{ currency: "USD", value }];
const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];
const rate = (rateDate: string, currency: string, twdPerUnit: number): ExchangeRateDto => ({ rateDate, currency, twdPerUnit });

/** One account whose own history is the whole portfolio's history. */
function only(owner: AccountRowDto, history: DailyHistoryRowDto[]): Partial<OverviewModelInput> {
  return { accounts: [owner], dailyHistory: history, dailyHistoryByAccount: { [owner.id]: history } };
}

function input(overrides: Partial<OverviewModelInput>): OverviewModelInput {
  return {
    importedAt: null,
    accounts: [],
    dailyHistory: [],
    dailyHistoryByAccount: {},
    exchangeRates: [],
    holdingPrices: [],
    ...overrides,
  };
}

test("each history date converts at that date's rate, so an FX-only move shows on the chart", () => {
  const model = readOverview(input({
    ...only(account("usd", "foreign", usd(100)), [row("2026-10-02", usd(100)), row("2026-10-01", usd(100))]),
    exchangeRates: [rate("2026-10-01", "USD", 30), rate("2026-10-02", "USD", 31)],
  }), { today: "2026-10-02" });
  assert.deepEqual(model.series, [{ date: "2026-10-01", value: 3000 }, { date: "2026-10-02", value: 3100 }]);
  assert.deepEqual(model.netWorth.chips[0], {
    kind: "latest", date: "2026-10-02", previousDate: "2026-10-01", isToday: true, change: 100, pct: 100 / 3000,
  });
  assert.equal(model.netWorth.value, 3100, "the headline values current accounts at the latest history date");
  const detail = model.historyRows.find((history) => history.date === "2026-10-02");
  assert.deepEqual(detail?.dailyChange, [{ currency: "TWD", value: 100 }], "the detail table diffs converted net worth, not native amounts");
});

test("a date with no rate yet is left off the chart instead of plotted as zero", () => {
  const model = readOverview(input({
    ...only(account("usd", "foreign", usd(100)), [row("2026-09-01", usd(100)), row("2026-10-01", usd(100))]),
    exchangeRates: [rate("2026-09-20", "USD", 30)],
  }), { today: "2026-10-01" });
  assert.deepEqual(model.series, [{ date: "2026-10-01", value: 3000 }]);
  assert.equal(model.historyRows[0]?.exchangeRateMissing, true);
  assert.deepEqual(model.netWorth.chips, [], "one point has nothing to compare against");
});

test("the latest chip names its date when the newest record is not today, and range chips need history", () => {
  const model = readOverview(input({
    ...only(account("bank", "bank", twd(1500)), [row("2026-08-01", twd(1000)), row("2026-09-01", twd(1200)), row("2026-10-03", twd(1500)), row("2026-10-04", twd(1400))]),
  }), { today: "2026-10-05" });
  const [latest, trailing, since] = model.netWorth.chips;
  assert.equal(latest?.kind, "latest");
  assert.equal(latest?.kind === "latest" && latest.isToday, false);
  assert.equal(latest?.change, -100);
  assert.deepEqual(trailing, { kind: "trailing-30", change: 200, pct: 200 / 1200 });
  assert.deepEqual(since, { kind: "since-start", since: "2026-08-01", change: 400, pct: 0.4 });
});

test("daily bars cover 14 calendar days ending today and leave days without a record empty", () => {
  const model = readOverview(input({
    ...only(account("bank", "bank", twd(1100)), [row("2026-09-01", twd(900)), row("2026-10-03", twd(1000)), row("2026-10-05", twd(1100))]),
  }), { today: "2026-10-05" });
  assert.equal(model.dailyBars.length, 14);
  assert.equal(model.dailyBars[0]?.date, "2026-09-22");
  assert.equal(model.dailyBars.at(-1)?.date, "2026-10-05");
  assert.deepEqual(model.dailyBars.filter((bar) => bar.change !== null), [
    { date: "2026-10-03", change: 100 },
    { date: "2026-10-05", change: 100 },
  ]);
  const later = readOverview(input({
    ...only(account("bank", "bank", twd(1100)), [row("2026-10-03", twd(1000)), row("2026-10-05", twd(1100))]),
  }), { today: "2026-10-08" });
  assert.deepEqual(later.dailyBars.slice(-3), [
    { date: "2026-10-06", change: null },
    { date: "2026-10-07", change: null },
    { date: "2026-10-08", change: null },
  ], "days after the last sync stay empty rather than shifting the window");
});

test("today's change splits by account, carries stale accounts forward, and states only provable reasons", () => {
  const foreign = account("foreign", "foreign", usd(100));
  const maicoin = account("maicoin", "crypto", twd(9000));
  const broker = account("broker", "brokerage", twd(5000));
  const bank = account("bank", "bank", twd(2000));
  const prices: OverviewHoldingPriceDto[] = [
    { accountId: "maicoin", symbol: "BTC", name: "BTC", kind: "crypto", cash: false, currency: "TWD", observations: [{ date: "2026-10-04", price: 100 }, { date: "2026-10-05", price: 90 }] },
    { accountId: "maicoin", symbol: "TWD", name: "TWD", kind: "crypto", cash: true, currency: "TWD", observations: [{ date: "2026-10-05", price: 1 }] },
    { accountId: "broker", symbol: "A", name: "A", kind: "brokerage", cash: false, currency: "TWD", observations: [{ date: "2026-10-05", price: 10 }] },
    { accountId: "broker", symbol: "B", name: "B", kind: "brokerage", cash: false, currency: "TWD", observations: [{ date: "2026-10-05", price: 20 }] },
  ];
  const model = readOverview(input({
    accounts: [foreign, maicoin, broker, bank],
    exchangeRates: [rate("2026-10-04", "USD", 30), rate("2026-10-05", "USD", 30.3)],
    dailyHistory: [
      row("2026-10-04", [{ currency: "TWD", value: 10000 + 4000 + 2000 }, ...usd(100)]),
      row("2026-10-05", [{ currency: "TWD", value: 9000 + 5000 + 2000 }, ...usd(100)]),
    ],
    dailyHistoryByAccount: {
      foreign: [row("2026-09-30", usd(100))],
      maicoin: [row("2026-10-04", twd(10000)), row("2026-10-05", twd(9000))],
      broker: [row("2026-10-04", twd(4000)), row("2026-10-05", twd(5000))],
      bank: [row("2026-10-01", twd(2000))],
    },
    holdingPrices: prices,
  }), { today: "2026-10-05" });
  assert.equal(model.todayChange.state, "ready");
  if (model.todayChange.state !== "ready") return;
  assert.equal(Math.round(model.todayChange.total), -1000 + 1000 + 30);
  assert.deepEqual(model.todayChange.rows.map((entry) => [entry.account.id, Math.round(entry.change)]), [
    ["maicoin", -1000],
    ["broker", 1000],
    ["foreign", 30],
  ], "the unchanged bank is omitted and the stale foreign account moves only by FX");
  const reasons = Object.fromEntries(model.todayChange.rows.map((entry) => [entry.account.id, entry.reason]));
  assert.equal(reasons.maicoin?.kind, "price", "cash beside a single coin does not hide the coin's price move");
  assert.ok(reasons.maicoin?.kind === "price" && Math.abs(reasons.maicoin.pct - -0.1) < 1e-9);
  assert.equal(reasons.broker, null, "two holdings cannot be attributed to one price");
  assert.ok(reasons.foreign?.kind === "fx" && reasons.foreign.currency === "USD" && Math.abs(reasons.foreign.pct - 0.01) < 1e-9);
  assert.ok(Math.abs((model.todayChange.cryptoShare ?? 0) - 1000 / 2030) < 1e-9);
});

test("today's change needs two dated records", () => {
  const model = readOverview(input({
    ...only(account("bank", "bank", twd(1)), [row("2026-10-05", twd(1))]),
  }), { today: "2026-10-05" });
  assert.deepEqual(model.todayChange, { state: "insufficient" });
});

test("the ticker shows only held currencies and coins, priced from the user's own data", () => {
  const model = readOverview(input({
    accounts: [account("usd", "foreign", usd(10)), account("bank", "bank", twd(5))],
    exchangeRates: [rate("2026-10-02", "USD", 30), rate("2026-10-03", "USD", 30.3), rate("2026-10-03", "JPY", 0.2)],
    holdingPrices: [
      { accountId: "max", symbol: "BTC", name: "BTC", kind: "crypto", cash: false, currency: "TWD", observations: [{ date: "2026-10-01", price: 200 }] },
      { accountId: "maicoin", symbol: "BTC", name: "BTC", kind: "crypto", cash: false, currency: "TWD", observations: [{ date: "2026-10-03", price: 100 }, { date: "2026-10-04", price: 98 }] },
      { accountId: "maicoin", symbol: "TWD", name: "TWD", kind: "crypto", cash: true, currency: "TWD", observations: [{ date: "2026-10-04", price: 1 }] },
      { accountId: "broker", symbol: "2330", name: "TSMC", kind: "brokerage", cash: false, currency: "TWD", observations: [{ date: "2026-10-04", price: 1000 }] },
    ],
  }), { today: "2026-10-05" });
  assert.equal(model.ticker.state, "items");
  if (model.ticker.state !== "items") return;
  assert.deepEqual(model.ticker.items.map((item) => item.code), ["USD", "BTC"], "JPY is not held and stocks are not quoted");
  const [usdItem, btcItem] = model.ticker.items;
  assert.equal(usdItem?.price, 30.3);
  assert.ok(Math.abs((usdItem?.changePct ?? 0) - 0.01) < 1e-9);
  assert.equal(btcItem?.price, 98, "the newest observation wins across exchanges");
  assert.ok(Math.abs((btcItem?.changePct ?? 0) - -0.02) < 1e-9);
});

test("the ticker explains why it is empty", () => {
  const today = { today: "2026-10-05" };
  assert.deepEqual(readOverview(input({}), today).ticker, { state: "rates-pending" });
  assert.deepEqual(readOverview(input({ accounts: [account("usd", "foreign", usd(1))] }), today).ticker, { state: "rates-pending" });
  assert.deepEqual(readOverview(input({ accounts: [account("bank", "bank", twd(1))] }), today).ticker, { state: "domestic-only" });
});

test("allocations group assets by kind, list each debt, and relate them", () => {
  const loan = account("loan", "loan", twd(800));
  const card = account("card", "credit-card", twd(200));
  const model = readOverview(input({
    accounts: [
      account("broker", "brokerage", twd(1000)),
      account("fund", "fund", twd(500)),
      account("bank-a", "bank", twd(300)),
      account("bank-b", "bank", twd(200)),
      account("usd", "foreign", usd(10)),
      account("eur", "foreign", [{ currency: "EUR", value: 5 }]),
      loan,
      card,
    ],
    dailyHistory: [row("2026-10-04", twd(1))],
    exchangeRates: [rate("2026-10-01", "USD", 30)],
  }), { today: "2026-10-05" });
  assert.deepEqual(model.assetAllocation.slices.map((slice) => [slice.category, slice.value]), [
    ["brokerage", 1000], ["fund", 500], ["bank", 500], ["foreign", 300],
  ]);
  assert.equal(model.assetAllocation.total, 2300);
  assert.equal(model.assetAllocation.valuationDate, "2026-10-04");
  assert.deepEqual(model.assetAllocation.unconvertedCurrencies, ["EUR"], "an unconvertible account is named, not silently priced");
  assert.deepEqual(model.liabilityAllocation.slices.map((slice) => [slice.account.id, slice.share]), [["loan", 0.8], ["card", 0.2]]);
  assert.equal(model.liabilityAllocation.total, 1000);
  assert.equal(model.liabilityAllocation.ratio, 1000 / 2300);
  assert.equal(model.netWorth.value, null, "the headline is withheld while a held currency has no rate");
});

test("a range keeps the points inside that many days of the newest point", () => {
  const series = [
    { date: "2026-06-01", value: 1 },
    { date: "2026-09-04", value: 2 },
    { date: "2026-09-05", value: 3 },
    { date: "2026-10-05", value: 4 },
  ];
  assert.deepEqual(seriesInRange(series, "30d").map((point) => point.date), ["2026-09-05", "2026-10-05"]);
  assert.deepEqual(seriesInRange(series, "90d").map((point) => point.date), ["2026-09-04", "2026-09-05", "2026-10-05"]);
  assert.equal(seriesInRange(series, "all").length, 4);
});

test("an account recorded for the first time is new coverage, not a change in net worth", () => {
  const bank = account("bank", "bank", twd(1100));
  const broker = account("broker", "brokerage", twd(5000));
  const maicoin = account("maicoin", "crypto", twd(800000));
  const model = readOverview(input({
    accounts: [bank, broker, maicoin],
    dailyHistory: [
      row("2026-09-25", twd(1000)),
      row("2026-09-30", twd(1050 + 5000)),
      row("2026-10-05", twd(1100 + 5200 + 800000)),
    ],
    dailyHistoryByAccount: {
      bank: [row("2026-09-25", twd(1000)), row("2026-09-30", twd(1050)), row("2026-10-05", twd(1100))],
      broker: [row("2026-09-30", twd(5000)), row("2026-10-05", twd(5200))],
      maicoin: [row("2026-10-05", twd(800000))],
    },
  }), { today: "2026-10-05" });
  assert.deepEqual(model.series.map((point) => point.value), [1000, 6050, 806300], "the chart still plots recorded net worth");
  assert.deepEqual(model.dailyBars.filter((bar) => bar.change !== null), [
    { date: "2026-09-30", change: 50 },
    { date: "2026-10-05", change: 250 },
  ], "a bar never counts a newly recorded balance");
  assert.equal(model.todayChange.state, "ready");
  if (model.todayChange.state !== "ready") return;
  assert.equal(model.todayChange.total, 250);
  assert.equal(model.todayChange.pct, 250 / 6050);
  assert.equal(model.todayChange.newAccountCount, 1);
  assert.deepEqual(model.todayChange.rows.map((entry) => entry.account.id), ["broker", "bank"], "the new account is not a contribution");
  const since = model.netWorth.chips.find((chip) => chip.kind === "since-start");
  assert.deepEqual(since && { change: since.change, pct: since.pct }, { change: 100, pct: 0.1 }, "since-start compares only accounts recorded at the start");
  const detail = model.historyRows.find((history) => history.date === "2026-10-05");
  assert.deepEqual(detail?.dailyChange, [{ currency: "TWD", value: 250 }]);
});
