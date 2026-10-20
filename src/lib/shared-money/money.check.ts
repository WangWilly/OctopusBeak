import assert from "node:assert/strict";
import test from "node:test";
import { formatAmount, formatExactQuantity, formatMoney, formatTwd, formatTwdNumber } from "./money.ts";

test("formatMoney preserves exact canonical values beyond JavaScript precision", () => {
  assert.equal(
    formatMoney({
      currency: "USD",
      value: Number("123456789012345678901") / 100,
      exact: { coefficient: "123456789012345678901", scale: 2 },
    }, { locale: "en" }),
    "USD 1,234,567,890,123,456,789.01",
  );
  assert.equal(
    formatMoney({
      currency: "USD",
      value: Number.NaN,
      exact: { coefficient: "-1005", scale: 3 },
    }, { locale: "en", signed: true }),
    "USD −1.01",
  );
});

test("formatExactQuantity preserves fractional quantity without currency rounding", () => {
  assert.equal(formatExactQuantity({ coefficient: "1234567890123456789012300", scale: 4 }, "en"), "123,456,789,012,345,678,901.23");
  assert.equal(formatExactQuantity({ coefficient: "-5000", scale: 3 }, "en"), "−5");
  assert.equal(formatExactQuantity({ coefficient: "2500", scale: 0 }, "en"), "2,500");
});

test("every amount uses a true minus, its currency's precision, and the viewer's locale", () => {
  assert.equal(formatMoney({ currency: "TWD", value: -1234.4 }, { locale: "zh-TW" }), "TWD −1,234");
  assert.equal(formatMoney({ currency: "USD", value: 12.5 }, { locale: "en", signed: true }), "USD +12.50");
  assert.equal(formatAmount(-0.004, "USD", { locale: "en" }), "0.00", "a value that rounds to zero carries no sign");
  assert.equal(formatAmount(-1500, "JPY", { locale: "en" }), "−1,500");
  assert.equal(formatTwd(-19410, "en"), "TWD −19,410");
  assert.equal(formatTwdNumber(1860, "en", true), "+1,860");
  assert.equal(
    formatMoney({ currency: "TWD", value: -0.4, exact: { coefficient: "-4", scale: 1 } }, { locale: "en" }),
    "TWD 0",
    "an exact amount that rounds to zero carries no sign either",
  );
});
