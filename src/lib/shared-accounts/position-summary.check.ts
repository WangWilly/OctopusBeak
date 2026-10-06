import assert from "node:assert/strict";
import test from "node:test";

import type { AssetPositionDto, TransactionRowDto } from "../shared-ledger/types.ts";
import { positionPrice, positionShares, positionsCsv, recentDividends } from "./position-summary.ts";

const position = (symbol: string, units: string, value: number | null, currency = "USD"): AssetPositionDto => ({
  symbol,
  name: symbol,
  units,
  value,
  valueExact: value === null ? null : { coefficient: String(Math.round(value * 100)), scale: 2 },
  currency,
});

test("the current price is the position value per unit, when both are known", () => {
  assert.equal(positionPrice(position("GOOG", "43", 14784.69)), 14784.69 / 43);
  assert.equal(positionPrice(position("CBRG", "1,500", 4140)), 2.76);
  assert.equal(positionPrice(position("NEW", "10", null)), null);
  assert.equal(positionPrice(position("DUST", "0", 0)), null);
  assert.equal(positionPrice(position("ODD", "--", 12)), null);
});

test("each holding's share is of the account's valued positions in the same currency", () => {
  const shares = positionShares([position("GOOG", "43", 750), position("MU", "7", 250), position("NEW", "1", null), position("TW", "1", 900, "TWD")]);
  assert.equal(shares.get("GOOG"), 0.75);
  assert.equal(shares.get("MU"), 0.25);
  assert.equal(shares.has("NEW"), false);
  assert.equal(shares.has("TW"), false, "a currency other than the largest one has no comparable share");
});

test("dividends in the last 90 days add up per currency", () => {
  const dividend = (date: string, amount: number, currency = "USD"): TransactionRowDto => ({
    date, occurredAtUtc: null, label: "Dividend", type: "dividend", amount, currency, note: null,
    investment: { securityName: "GOOG", quantity: { coefficient: "0", scale: 0 } },
  });
  const rows = [dividend("2026-09-01", 4.21), dividend("2026-10-01", 3.5), dividend("2026-06-01", 9), { ...dividend("2026-10-02", -100), type: "buy" }];
  assert.deepEqual(recentDividends(rows, "2026-10-05", "Asia/Taipei"), { count: 2, totals: [{ currency: "USD", value: 7.71 }] });
  assert.deepEqual(recentDividends([], "2026-10-05", "Asia/Taipei"), { count: 0, totals: [] });
});

test("the CSV export lists each holding with its price, value and share", () => {
  const rows = [position("GOOG", "43", 750), position("MU", "7", 250)];
  const csv = positionsCsv(rows, { symbol: "代號", name: "名稱", units: "股數", price: "現價", value: "市值", currency: "幣別", share: "佔帳戶" });
  assert.equal(csv, "﻿代號,名稱,股數,現價,市值,幣別,佔帳戶\r\nGOOG,GOOG,43,17.44186,750.00,USD,75.0%\r\nMU,MU,7,35.71429,250.00,USD,25.0%\r\n");
});
