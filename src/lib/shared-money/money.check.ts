import assert from "node:assert/strict";
import test from "node:test";
import { formatExactQuantity, formatMoney } from "./money.ts";

test("formatMoney preserves exact canonical values beyond JavaScript precision", () => {
  assert.equal(
    formatMoney({
      currency: "USD",
      value: Number("123456789012345678901") / 100,
      exact: { coefficient: "123456789012345678901", scale: 2 },
    }),
    "USD 1,234,567,890,123,456,789.01",
  );
  assert.equal(
    formatMoney({
      currency: "USD",
      value: Number.NaN,
      exact: { coefficient: "-1005", scale: 3 },
    }, { signed: true }),
    "USD -1.01",
  );
});

test("formatExactQuantity preserves fractional quantity without currency rounding", () => {
  assert.equal(formatExactQuantity({ coefficient: "1234567890123456789012300", scale: 4 }), "123,456,789,012,345,678,901.23");
  assert.equal(formatExactQuantity({ coefficient: "-5000", scale: 3 }), "-5");
  assert.equal(formatExactQuantity({ coefficient: "2500", scale: 0 }), "2,500");
});
