import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBinanceInvestmentCaptures,
  deriveBinanceAccountKey,
  type BinanceInvestmentCaptureBuildInput,
} from "./binance-crypto-adapters.ts";
import { admitCanonicalInvestmentCapture } from "./investment-financial-admission.ts";

const amount = (coefficient: string, scale = 0) => ({ coefficient, scale });
const providerDate = { sourceValue: "Sat, 31 Oct 2026 07:00:00 GMT", effectiveAt: "2026-10-31T07:00:00.000Z" };
const SEPTEMBER_FIRST_TAIPEI_MORNING = Date.parse("2026-09-01T09:30:00+08:00");

const SYNTHETIC_BINANCE_INPUT: BinanceInvestmentCaptureBuildInput = {
  captureId: "synthetic-binance-run",
  uid: "123456789",
  wallets: [
    { wallet: "spot", providerDate, balances: [{ asset: "BTC", quantity: amount("15", 2) }, { asset: "SOL", quantity: amount("3") }] },
    { wallet: "funding", providerDate, balances: [{ asset: "USDT", quantity: amount("100") }] },
  ],
  trades: [{
    symbol: "BTCUSDT", id: "42", baseAsset: "BTC", quoteAsset: "USDT", side: "buy",
    quantity: amount("1", 1), quoteQuantity: amount("6000"), time: SEPTEMBER_FIRST_TAIPEI_MORNING,
  }],
  fundMovements: [
    { kind: "deposit", id: "d1", wallet: "spot", asset: "ETH", amount: amount("2"), time: SEPTEMBER_FIRST_TAIPEI_MORNING },
    { kind: "withdrawal", id: "w1", wallet: "funding", asset: "USDT", amount: amount("10"), time: SEPTEMBER_FIRST_TAIPEI_MORNING },
  ],
  transfers: [{ tranId: "77", from: "spot", to: "funding", asset: "USDT", amount: amount("5"), time: SEPTEMBER_FIRST_TAIPEI_MORNING }],
  valuationQuotes: new Map([["BTC", {
    price: amount("1920000"),
    components: [{ market: "BTCUSDT", price: "60000" }, { market: "max:usdttwd", price: "32" }],
  }]]),
};

test("spot and funding become two Crypto financial accounts with complete holding snapshots", () => {
  const [spot, funding] = buildBinanceInvestmentCaptures(SYNTHETIC_BINANCE_INPUT);
  assert.equal(spot!.identity.accountKey, deriveBinanceAccountKey("123456789", "spot"));
  assert.equal(funding!.identity.accountKey, deriveBinanceAccountKey("123456789", "funding"));
  assert.notEqual(spot!.identity.accountKey, funding!.identity.accountKey);
  assert.equal(spot!.identity.sourceConnectionKey, funding!.identity.sourceConnectionKey, "one Source connection per Binance UID");
  for (const capture of [spot!, funding!]) {
    assert.equal(capture.identity.accountSubtype, "crypto_exchange");
    assert.deepEqual(capture.scope.holdingSnapshot, { sourceField: "http-date", value: "2026-10-31", contractVersion: "binance/investment/canonical-v1" });
    assert.equal(capture.scope.transactionHistory, undefined, "a Bounded trade history never claims a complete range");
    admitCanonicalInvestmentCapture(capture);
  }
});

test("a quoted holding is valued in TWD and an unquoted one keeps only its quantity", () => {
  const [spot] = buildBinanceInvestmentCaptures(SYNTHETIC_BINANCE_INPUT);
  const btc = spot!.holdings.find(({ securityKey }) => securityKey === "binance:BTC")!;
  assert.deepEqual(btc.quantity, amount("15", 2));
  assert.deepEqual(btc.valuation, { coefficient: "288000", scale: 0, currency: "TWD" });
  assert.deepEqual(btc.effectiveTimeEvidence.components, [
    { role: "market-price", sourceField: "BTCUSDT", value: "60000" },
    { role: "market-price", sourceField: "max:usdttwd", value: "32" },
  ]);
  const sol = spot!.holdings.find(({ securityKey }) => securityKey === "binance:SOL")!;
  assert.deepEqual(sol.quantity, amount("3"));
  assert.equal(sol.valuation, undefined);
});

test("trades and movements map to investment actions on the wallet that booked them", () => {
  const [spot, funding] = buildBinanceInvestmentCaptures(SYNTHETIC_BINANCE_INPUT);
  const rows = (capture: typeof spot) => capture!.transactions.map(({ securityKey, action, quantity, cashEffect, effectiveOn }) =>
    [securityKey, action, quantity, cashEffect, effectiveOn]);
  const zeroTwd = { coefficient: "0", scale: 0, currency: "TWD" };
  assert.deepEqual(rows(spot), [
    ["binance:BTC", "buy", amount("1", 1), { coefficient: "6000", scale: 0, currency: "USDT" }, "2026-09-01"],
    ["binance:ETH", "corporate_action_in", amount("2"), zeroTwd, "2026-09-01"],
    ["binance:USDT", "corporate_action_out", amount("5"), zeroTwd, "2026-09-01"],
  ]);
  assert.deepEqual(rows(funding), [
    ["binance:USDT", "corporate_action_out", amount("10"), zeroTwd, "2026-09-01"],
    ["binance:USDT", "corporate_action_in", amount("5"), zeroTwd, "2026-09-01"],
  ]);
  const transferKeys = [spot!.transactions[2]!.sourceRecordKey, funding!.transactions[1]!.sourceRecordKey];
  assert.equal(new Set(transferKeys).size, 2, "the transfer's two legs are distinct source records");
  assert.ok(spot!.securities.some(({ securityKey, securityType }) => securityKey === "binance:ETH" && securityType === "cryptocurrency"),
    "a deposited asset no longer held is still a captured Security");
});

test("a capture without both wallets is refused", () => {
  assert.throws(() => buildBinanceInvestmentCaptures({ ...SYNTHETIC_BINANCE_INPUT, wallets: SYNTHETIC_BINANCE_INPUT.wallets.slice(0, 1) }), /funding wallet/u);
});
