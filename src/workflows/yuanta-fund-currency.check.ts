import assert from "node:assert/strict";
import { canonicalYuantaFundCurrency, isYuantaFundSourceCurrencyLabel, yuantaFundSourceAmountCurrency } from "./yuanta-fund-currency.ts";

for (const [label, iso] of [
  ["台幣", "TWD"], ["美金", "USD"], ["港幣", "HKD"], ["澳幣", "AUD"],
  ["人民幣", "CNY"], ["南非幣", "ZAR"], ["紐幣", "NZD"], ["英鎊", "GBP"],
]) {
  assert.equal(canonicalYuantaFundCurrency(label!), iso);
  assert.equal(isYuantaFundSourceCurrencyLabel(label!), true);
  assert.equal(isYuantaFundSourceCurrencyLabel(iso!), true);
  assert.equal(yuantaFundSourceAmountCurrency(`${label} 1,000.25`), iso);
  assert.equal(yuantaFundSourceAmountCurrency(`1,000.25 ${iso}`), iso);
}
for (const value of ["100", "UNKNOWN 100", "USD -100", "USD 1,,000", "美元100 and 台幣200"])
  assert.throws(() => yuantaFundSourceAmountCurrency(value));
assert.equal(isYuantaFundSourceCurrencyLabel("USD 100"), false);
assert.equal(isYuantaFundSourceCurrencyLabel("UNKNOWN"), false);
