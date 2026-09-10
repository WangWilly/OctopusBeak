import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "./money.ts";

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
