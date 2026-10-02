import assert from "node:assert/strict";
import { canonicalYuantaFundCurrency, yuantaFundSourceAmountCurrency } from "./yuanta-fund-currency.ts";
import { yuantaFundAdditionalEventRows } from "./yuanta-fund-events.ts";
const decode = {
  amount(value: string) {
    const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.replace(/(?: USD| 台幣)$/u, ""));
    if (!match) throw new Error("Invalid test source amount");
    return { coefficient: match[1]! + (match[2] ?? ""), scale: match[2]?.length ?? 0 };
  },
  date: (value: string) => value.replaceAll("/", "-"),
  currency: canonicalYuantaFundCurrency,
  cashCurrency: yuantaFundSourceAmountCurrency,
};
const conversion = {
  交易編號: "SYNTHETIC-CHAIN", 轉出基金: "SANITIZED FUND Ｕ美元", 轉入基金: "SANITIZED FUND Ａ美元",
  轉出日期: "2026/08/10", 轉入日期: "2026/08/11", 轉出單位數: "1.25", 轉入單位數: "2.5",
  轉換投資金額: "123.45 USD", 銀行轉換手續費: "0",
};
const map = (label: string, row: Record<string, string>) => yuantaFundAdditionalEventRows(label, row, "scope", decode);
const legs = map("conversion-details", conversion);
assert.deepEqual(legs.map(row => [row.producerSecurityId, row.action, row.effectiveOn, row.cashEffect]), [
  ["name:SANITIZED FUND U美元", "sell", "2026-08-10", { coefficient: "12345", scale: 2, currency: "USD" }],
  ["name:SANITIZED FUND A美元", "buy", "2026-08-11", { coefficient: "12345", scale: 2, currency: "USD" }],
]);
assert.notEqual(legs[0]?.sourceRecordKey, legs[1]?.sourceRecordKey);
assert.notEqual(map("conversion-details", { ...conversion, 轉出日期: "2026/08/12" })[0]?.sourceRecordKey, legs[0]?.sourceRecordKey);
assert.deepEqual(map("conversion-details", { ...conversion, 銀行轉換手續費: "1 USD" }).map(row => row.cashEffect), legs.map(row => row.cashEffect), "Internal fees cannot be deducted from confirmed net proceeds a second time");
assert.equal(map("conversion-details", { ...conversion, 轉入基金: "UNLISTED" })[1]?.producerSecurityId,
  "name:UNLISTED", "Missing catalog metadata cannot reject named financial evidence");
assert.throws(() => map("conversion-details", { ...conversion, 轉入基金: " " }), /source name/u);
const accountLegs = map("conversion-details", { ...conversion, 轉換投資金額: "123.45 台幣" });
assert.deepEqual(accountLegs.map(row => [row.currency, row.securityCurrency, row.cashEffect]), [
  ["TWD", null, { coefficient: "12345", scale: 2, currency: "TWD" }],
  ["TWD", null, { coefficient: "12345", scale: 2, currency: "TWD" }],
]);
assert.throws(() => map("conversion-details", { ...conversion, 轉換投資金額: "123.45" }), /explicit source currency/u);
const dividend = map("cash-dividend-details", { 基金名稱: "SANITIZED FUND A美元", 入帳日期: "2026/08/12", 計價幣別: "USD", 分配金額: "4.2" })[0]!;
assert.equal(dividend.action, "dividend");
assert.deepEqual(dividend.quantity, { coefficient: "0", scale: 0 });
assert.deepEqual(dividend.cashEffect, { coefficient: "42", scale: 1, currency: "USD" });
const units = map("unit-dividend-details", { 基金名稱: "SANITIZED FUND A美元", 分配日期: "2026/08/13", 分配單位數: "0.125" })[0]!;
assert.equal(units.action, "corporate_action_in");
assert.deepEqual(units.quantity, { coefficient: "0125", scale: 3 });
assert.deepEqual(units.cashEffect, { coefficient: "0", scale: 0, currency: "XXX" });
const named = map("conversion-details", {
  ...conversion, 轉出基金: "SYNTHETIC ＵＮＬＩＳＴＥＤ OUT", 轉入基金: "SYNTHETIC UNLISTED IN", 轉換投資金額: "123.45 台幣",
});
assert.deepEqual(named.map(row => [row.producerSecurityId, row.securityCurrency, row.cashEffect?.currency]), [
  ["name:SYNTHETIC UNLISTED OUT", null, "TWD"], ["name:SYNTHETIC UNLISTED IN", null, "TWD"],
]);
const normalized = map("conversion-details", {
  ...conversion, 轉出基金: "SYNTHETIC UNLISTED OUT", 轉入基金: "SYNTHETIC UNLISTED IN", 轉換投資金額: "123.45 台幣",
});
assert.deepEqual(normalized.map(row => row.sourceRecordKey), named.map(row => row.sourceRecordKey));
const namedUnits = map("unit-dividend-details", {
  基金名稱: "SYNTHETIC UNLISTED OUT", 分配日期: "2026/08/13", 分配單位數: "0.125",
})[0]!;
assert.equal(namedUnits.securityCurrency, null);
assert.deepEqual(namedUnits.cashEffect, { coefficient: "0", scale: 0, currency: "XXX" });
const hkdDividend = map("cash-dividend-details", {
  基金名稱: "SYNTHETIC UNLISTED OUT", 入帳日期: "2026/08/12", 計價幣別: "港幣", 分配金額: "4.2",
})[0]!;
assert.deepEqual(hkdDividend.cashEffect, { coefficient: "42", scale: 1, currency: "HKD" });
assert.equal(hkdDividend.securityCurrency, null);
console.log("Yuanta fund event mapping checks passed");
