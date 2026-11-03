import assert from "node:assert/strict";
import test from "node:test";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, ExchangeRateDto } from "../shared-ledger/types.ts";
import { indexExchangeRates } from "../shared-money/exchange-rates.ts";
import { currentNetPosition, valuationDateFor } from "../shared-ledger/twd-valuation.ts";
import { readOverview, seriesInRange, type OverviewModelInput } from "./overview-model.ts";
import type { OverviewHoldingPriceDto } from "./types.ts";
import { NO_PROVENANCE, originProvenance } from "../shared-ledger/provenance.ts";

const PREVIEW = originProvenance("preview");
const MANUAL = originProvenance("manual");

function account(id: string, kind: AccountRowDto["kind"], amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: "Account",
    group: kind === "credit-card" || kind === "loan" ? "liability" : ["fund", "brokerage", "crypto"].includes(kind) ? "investment" : "asset",
    kind,
    amountLines,
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
  };
}

function row(date: string, net: CurrencyAmountDto[]): DailyHistoryRowDto {
  return { date, netAssets: net, dailyChange: [], assets: net, liabilities: [], accountChanges: [], positionCount: 0, provenance: NO_PROVENANCE };
}

const usd = (value: number): CurrencyAmountDto[] => [{ currency: "USD", value }];
const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];
const rate = (rateDate: string, currency: string, twdPerUnit: number): ExchangeRateDto => ({ rateDate, currency, twdPerUnit });

/** One account whose own history is the whole portfolio's history. */
function only(owner: AccountRowDto, history: DailyHistoryRowDto[]): Partial<OverviewModelInput> {
  return { accounts: [owner], dailyHistory: history, dailyHistoryByAccount: { [owner.id]: history } };
}

/** The current Net position the ledger publishes, from the same inputs the model reads. */
function currentNet(dto: OverviewModelInput) {
  return currentNetPosition(dto.accounts, indexExchangeRates(dto.exchangeRates), dto.valuationDate);
}

/** The page as the ledger would publish it on 2026-10-05, valuation date included. */
function input(overrides: Partial<OverviewModelInput>): OverviewModelInput {
  return {
    valuationDate: valuationDateFor(overrides.dailyHistory ?? [], overrides.exchangeRates ?? [], "2026-10-05"),
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
  const dto = input({
    ...only(account("usd", "foreign", usd(100)), [row("2026-10-02", usd(100)), row("2026-10-01", usd(100))]),
    exchangeRates: [rate("2026-10-01", "USD", 30), rate("2026-10-02", "USD", 31)],
  });
  const model = readOverview(dto, { today: "2026-10-02" });
  const current = currentNet(dto);
  assert.deepEqual(model.series, [{ date: "2026-10-01", value: 3000, provenance: NO_PROVENANCE }, { date: "2026-10-02", value: 3100, provenance: NO_PROVENANCE }]);
  assert.deepEqual(model.netWorth.chips[0], {
    kind: "latest", date: "2026-10-02", previousDate: "2026-10-01", isToday: true, change: 100, pct: 100 / 3000,
  });
  assert.equal(current.value, 3100, "the headline values current accounts at the latest history date");
  const detail = model.historyRows.find((history) => history.date === "2026-10-02");
  assert.deepEqual(detail?.dailyChange, [{ currency: "TWD", value: 100 }], "the detail table diffs converted net worth, not native amounts");
});

test("a date with no rate yet is left off the chart instead of plotted as zero", () => {
  const model = readOverview(input({
    ...only(account("usd", "foreign", usd(100)), [row("2026-09-01", usd(100)), row("2026-10-01", usd(100))]),
    exchangeRates: [rate("2026-09-20", "USD", 30)],
  }), { today: "2026-10-01" });
  assert.deepEqual(model.series, [{ date: "2026-10-01", value: 3000, provenance: NO_PROVENANCE }]);
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
    { date: "2026-10-03", change: 100, provenance: NO_PROVENANCE },
    { date: "2026-10-05", change: 100, provenance: NO_PROVENANCE },
  ]);
  const later = readOverview(input({
    ...only(account("bank", "bank", twd(1100)), [row("2026-10-03", twd(1000)), row("2026-10-05", twd(1100))]),
  }), { today: "2026-10-08" });
  assert.deepEqual(later.dailyBars.slice(-3), [
    { date: "2026-10-06", change: null, provenance: NO_PROVENANCE },
    { date: "2026-10-07", change: null, provenance: NO_PROVENANCE },
    { date: "2026-10-08", change: null, provenance: NO_PROVENANCE },
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
  const dto = input({
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
  });
  const model = readOverview(dto, { today: "2026-10-05" });
  const current = currentNet(dto);
  assert.deepEqual(model.assetAllocation.slices.map((slice) => [slice.category, slice.value]), [
    ["brokerage", 1000], ["fund", 500], ["bank", 500], ["foreign", 300],
  ]);
  assert.equal(model.assetAllocation.total, 2300);
  assert.equal(model.assetAllocation.valuationDate, "2026-10-04");
  assert.deepEqual(model.assetAllocation.unconvertedCurrencies, ["EUR"], "an unconvertible account is named, not silently priced");
  assert.equal(model.assetAllocation.incomplete, true, "the verified EUR account has no rate");
  assert.deepEqual(model.liabilityAllocation.slices.map((slice) => [slice.account.id, slice.share]), [["loan", 0.8], ["card", 0.2]]);
  assert.equal(model.liabilityAllocation.total, 1000);
  assert.equal(model.liabilityAllocation.incomplete, false);
  assert.equal(model.liabilityAllocation.ratio, null, "no debt ratio against an incomplete Assets total");
  assert.equal(current.value, null, "the headline is withheld while a held currency has no rate");
});

test("a range keeps the points inside that many days of the newest point", () => {
  const series = [
    { date: "2026-06-01", value: 1, provenance: NO_PROVENANCE },
    { date: "2026-09-04", value: 2, provenance: NO_PROVENANCE },
    { date: "2026-09-05", value: 3, provenance: NO_PROVENANCE },
    { date: "2026-10-05", value: 4, provenance: NO_PROVENANCE },
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
    { date: "2026-09-30", change: 50, provenance: NO_PROVENANCE },
    { date: "2026-10-05", change: 250, provenance: NO_PROVENANCE },
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

function previewAccount(id: string, amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    ...account(id, amountLines[0]?.currency === "TWD" ? "bank" : "foreign", amountLines),
    preview: { sourceId: "synthetic", product: "deposit", lastCollectedAt: "2026-10-05T00:00:00Z", balanceTime: null, transactions: [] },
  };
}

test("a preview balance without a rate never blanks verified net worth", () => {
  const dto = input({
    accounts: [account("bank", "bank", twd(1000)), previewAccount("preview:usd", usd(10))],
    dailyHistory: [row("2026-10-05", twd(1000))],
  });
  const current = currentNet(dto);
  assert.equal(current.value, 1000);
  assert.deepEqual(current.provenance, NO_PROVENANCE);
  assert.deepEqual(current.unconvertedCurrencies, ["USD"]);
});

test("a preview balance with a rate is converted into net worth and marked", () => {
  const dto = input({
    accounts: [account("bank", "bank", twd(1000)), previewAccount("preview:usd", usd(10))],
    dailyHistory: [row("2026-10-05", twd(1000))],
    exchangeRates: [rate("2026-10-01", "USD", 32)],
  });
  const current = currentNet(dto);
  assert.equal(current.value, 1320);
  assert.deepEqual(current.provenance, PREVIEW);
  assert.deepEqual(current.unconvertedCurrencies, []);
});

test("a counted TWD preview balance marks net worth beside a rateless preview one", () => {
  const dto = input({
    accounts: [previewAccount("preview:twd", twd(500)), previewAccount("preview:usd", usd(10))],
    dailyHistory: [row("2026-10-05", twd(500))],
  });
  const current = currentNet(dto);
  assert.equal(current.value, 500);
  assert.deepEqual(current.provenance, PREVIEW);
  assert.deepEqual(current.unconvertedCurrencies, ["USD"]);
});

test("a rateless or balance-less preview account leaves the allocation unmarked", () => {
  const dto = input({
    accounts: [account("bank", "bank", twd(1000)), previewAccount("preview:usd", usd(10)), previewAccount("preview:empty", [])],
    dailyHistory: [row("2026-10-05", twd(1000))],
  });
  const model = readOverview(dto, { today: "2026-10-05" });
  const current = currentNet(dto);
  assert.equal(model.assetAllocation.total, 1000);
  assert.deepEqual(model.assetAllocation.provenance, NO_PROVENANCE);
  assert.deepEqual(model.assetAllocation.unconvertedCurrencies, ["USD"]);
  assert.equal(model.assetAllocation.incomplete, false, "a preview account without a rate leaves the total complete");
  assert.equal(current.value, 1000);
  assert.deepEqual(current.provenance, NO_PROVENANCE);
});

test("a canonical account without a rate still blanks net worth", () => {
  const dto = input({
    accounts: [account("bank", "bank", twd(1000)), account("fx", "foreign", usd(10))],
    dailyHistory: [row("2026-10-05", twd(1000))],
  });
  const current = currentNet(dto);
  assert.equal(current.value, null);
});

test("history-driven totals carry the preview flag only where a preview row is counted", () => {
  const previewRows = [
    { ...row("2026-10-03", twd(100)), provenance: PREVIEW },
    { ...row("2026-10-05", twd(300)), provenance: PREVIEW },
  ];
  const model = readOverview(input({
    accounts: [account("bank", "bank", twd(1000)), previewAccount("preview:twd", twd(300))],
    dailyHistory: [
      row("2026-10-01", twd(1000)),
      { ...row("2026-10-03", twd(1100)), provenance: PREVIEW },
      { ...row("2026-10-05", twd(1300)), provenance: PREVIEW },
    ],
    dailyHistoryByAccount: { bank: [row("2026-10-01", twd(1000))], "preview:twd": previewRows },
  }), { today: "2026-10-05" });
  assert.deepEqual(model.series.map((point) => point.provenance.preview), [false, true, true]);
  assert.equal(model.todayChange.state === "ready" && model.todayChange.provenance.preview, true);
  assert.equal(model.todayChange.state === "ready" && model.todayChange.total, 200);
  assert.deepEqual(model.dailyBars.filter((bar) => bar.change !== null).map((bar) => [bar.date, bar.provenance.preview]), [
    ["2026-10-03", false],
    ["2026-10-05", true],
  ]);
  assert.deepEqual(model.historyRows.at(-1)!.provenance, PREVIEW);
});

function manualAccount(id: string, category: "cash" | "house", amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    ...account(id, "manual", amountLines),
    manual: { assetId: id, category, currency: "TWD", endedOn: null, valuations: [], transactions: [], balance: null },
  };
}

const marked = (entry: DailyHistoryRowDto, provenance = MANUAL): DailyHistoryRowDto => ({ ...entry, provenance });

test("a manual cash asset revalued today marks every change figure that counts it", () => {
  const model = readOverview(input({
    accounts: [account("bank", "bank", twd(1000)), manualAccount("manual:cash", "cash", twd(600))],
    dailyHistory: [row("2026-10-04", twd(1500)), row("2026-10-05", twd(1600))],
    dailyHistoryByAccount: {
      bank: [row("2026-10-04", twd(1000))],
      "manual:cash": [marked(row("2026-10-04", twd(500))), marked(row("2026-10-05", twd(600)))],
    },
  }), { today: "2026-10-05" });
  assert.equal(model.todayChange.state === "ready" && model.todayChange.total, 100);
  assert.deepEqual(model.todayChange.state === "ready" && model.todayChange.provenance, MANUAL);
  assert.deepEqual(model.dailyBars.at(-1), { date: "2026-10-05", change: 100, provenance: MANUAL });
  assert.deepEqual(model.netWorth.chipsProvenance, MANUAL);
  assert.deepEqual(model.historyRows.at(-1)!.provenance, MANUAL, "the row's daily change counts the revaluation");
});

test("a change over verified accounts only stays unmarked", () => {
  const model = readOverview(input({
    accounts: [account("bank", "bank", twd(1100)), manualAccount("manual:cash", "cash", twd(500))],
    dailyHistory: [row("2026-10-04", twd(1500)), row("2026-10-05", twd(1600))],
    dailyHistoryByAccount: {
      bank: [row("2026-10-04", twd(1000)), row("2026-10-05", twd(1100))],
      "manual:cash": [marked(row("2026-10-05", twd(500)))],
    },
  }), { today: "2026-10-05" });
  assert.deepEqual(model.todayChange.state === "ready" && model.todayChange.provenance, NO_PROVENANCE, "new manual coverage is not change");
  assert.deepEqual(model.dailyBars.at(-1)!.provenance, NO_PROVENANCE);
});

test("an asset allocation counting a manual house is marked manual", () => {
  const model = readOverview(input({
    accounts: [account("bank", "bank", twd(1000)), manualAccount("manual:house", "house", twd(9000000))],
    dailyHistory: [row("2026-10-05", twd(9001000))],
  }), { today: "2026-10-05" });
  assert.equal(model.assetAllocation.total, 9001000);
  assert.deepEqual(model.assetAllocation.provenance, MANUAL);
});

function previewLoan(id: string, amountLines: CurrencyAmountDto[]): AccountRowDto {
  return {
    ...account(id, "loan", amountLines),
    preview: { sourceId: "synthetic", product: "loan", lastCollectedAt: "2026-10-05T00:00:00Z", balanceTime: null, transactions: [] },
  };
}

test("the liability allocation's marker follows the accounts its rate-aware total counts", () => {
  const rateless = readOverview(input({
    accounts: [account("bank", "bank", twd(1000)), account("card", "credit-card", twd(200)), previewLoan("preview:usd-loan", usd(1000))],
    dailyHistory: [row("2026-10-05", twd(800))],
  }), { today: "2026-10-05" });
  assert.equal(rateless.liabilityAllocation.total, 200);
  assert.deepEqual(rateless.liabilityAllocation.unconvertedCurrencies, ["USD"]);
  assert.deepEqual(rateless.liabilityAllocation.provenance, NO_PROVENANCE, "a loan left out for lack of a rate marks nothing");
  assert.equal(rateless.liabilityAllocation.incomplete, false, "a preview loan without a rate leaves the total complete");

  const counted = readOverview(input({
    accounts: [account("bank", "bank", twd(1000)), previewLoan("preview:loan", twd(300))],
    dailyHistory: [row("2026-10-05", twd(700))],
  }), { today: "2026-10-05" });
  assert.deepEqual(counted.liabilityAllocation.provenance, PREVIEW);
});
