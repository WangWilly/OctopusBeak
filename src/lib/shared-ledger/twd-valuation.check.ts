import assert from "node:assert/strict";
import test from "node:test";
import { readAssetsSummary } from "../assets/assets-summary.ts";
import { readLiabilitiesSummary } from "../liabilities/liabilities-summary.ts";
import { indexExchangeRates } from "../shared-money/exchange-rates.ts";
import { NO_PROVENANCE } from "./provenance.ts";
import {
  currentNetPosition,
  readAssetAllocation,
  readLiabilityAllocation,
  valuationDateFor,
} from "./twd-valuation.ts";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, ExchangeRateDto } from "./types.ts";

function account(id: string, kind: AccountRowDto["kind"], amountLines: CurrencyAmountDto[], extra: Partial<AccountRowDto> = {}): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: "Account",
    group: kind === "credit-card" || kind === "loan" ? "liability" : "asset",
    kind,
    amountLines,
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
    ...extra,
  };
}

const preview = (product: "deposit" | "loan"): Partial<AccountRowDto> => ({
  preview: { sourceId: "synthetic", product, lastCollectedAt: "2026-10-05T00:00:00Z", balanceTime: null, transactions: [] },
});

function row(date: string): DailyHistoryRowDto {
  return { date, netAssets: [], dailyChange: [], assets: [], liabilities: [], accountChanges: [], positionCount: 0, provenance: NO_PROVENANCE };
}

const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];
const usd = (value: number): CurrencyAmountDto[] => [{ currency: "USD", value }];
const rate = (rateDate: string, currency: string, twdPerUnit: number): ExchangeRateDto => ({ rateDate, currency, twdPerUnit });

test("balances are valued at the newest history date, whatever order the rows arrive in or how new the rates are", () => {
  const rates = [rate("2026-10-25", "USD", 31)];
  assert.equal(valuationDateFor([row("2026-10-04"), row("2026-10-09"), row("2026-10-01")], rates, "2026-10-20"), "2026-10-09");
});

test("without history, the latest stored rates value the accounts", () => {
  assert.equal(valuationDateFor([], [], "2026-10-20"), "2026-10-20", "no rate: today");
  assert.equal(valuationDateFor([], [rate("2026-10-01", "USD", 30), rate("2026-10-15", "JPY", 0.2)], "2026-10-20"), "2026-10-20",
    "every stored rate is on or before today");
  assert.equal(valuationDateFor([], [rate("2026-10-21", "USD", 31), rate("2026-10-01", "JPY", 0.2)], "2026-10-20"), "2026-10-21",
    "a rate dated after today is still the latest stored rate");
});

test("a verified account without a rate withholds the Net position, while a preview one is only named", () => {
  const rates = indexExchangeRates([]);
  const verified = currentNetPosition([account("bank", "bank", twd(1000)), account("usd", "foreign", usd(10))], rates, "2026-10-05");
  assert.equal(verified.value, null, "the Net position is not a TWD figure");
  const previewed = currentNetPosition([account("bank", "bank", twd(1000)), account("usd", "foreign", usd(10), preview("deposit"))], rates, "2026-10-05");
  assert.equal(previewed.value, 1000);
  assert.deepEqual(previewed.unconvertedCurrencies, ["USD"]);
});

test("the side allocations leave a verified account without a rate out and name its currency", () => {
  const rates = indexExchangeRates([]);
  const assets = readAssetAllocation([account("bank", "bank", twd(1000)), account("usd", "foreign", usd(10))], rates, "2026-10-05");
  assert.equal(assets.total, 1000);
  assert.deepEqual(assets.unconvertedCurrencies, ["USD"]);
  const liabilities = readLiabilityAllocation([account("loan", "loan", twd(500)), account("usd-loan", "loan", usd(10))], rates, "2026-10-05", 1000);
  assert.equal(liabilities.total, 500);
  assert.deepEqual(liabilities.unconvertedCurrencies, ["USD"]);
});

test("allocations value each account at the valuation date's rate, not a later one", () => {
  const rates = indexExchangeRates([rate("2026-10-01", "USD", 30), rate("2026-10-06", "USD", 40)]);
  assert.equal(readAssetAllocation([account("usd", "foreign", usd(10))], rates, "2026-10-05").total, 300);
});

test("without history and with a rate dated after today, the Net position is the Assets total minus the Liabilities total", () => {
  const exchangeRates = [rate("2026-11-01", "USD", 32), rate("2026-11-05", "USD", 33)];
  const today = "2026-11-03";
  const valuationDate = valuationDateFor([], exchangeRates, today);
  const page = { valuationDate, dailyHistory: [], dailyHistoryByAccount: {}, exchangeRates };
  const assetAccounts = [account("bank", "bank", twd(1000)), account("usd", "foreign", usd(100))];
  const liabilityAccounts = [account("loan", "loan", twd(400)), account("usd-card", "credit-card", usd(10))];
  const net = currentNetPosition([...assetAccounts, ...liabilityAccounts], indexExchangeRates(exchangeRates), valuationDate);
  const assets = readAssetsSummary({ ...page, accounts: assetAccounts });
  const liabilities = readLiabilitiesSummary({ ...page, accounts: liabilityAccounts }, { today });
  assert.ok(assets.state === "ready" && liabilities.state === "ready");
  assert.equal(assets.total, 1000 + 3300, "the side totals use the later rate, as the Net position does");
  assert.equal(net.value, assets.total - liabilities.total);
});
