import assert from "node:assert/strict";
import test from "node:test";
import type { ExchangeRateDto } from "../shared-ledger/types.ts";
import { convertToTwd, indexExchangeRates, rateOnOrBefore } from "./exchange-rates.ts";

const rates: ExchangeRateDto[] = [
  { rateDate: "2026-07-13", currency: "USD", twdPerUnit: 33 },
  { rateDate: "2026-07-11", currency: "USD", twdPerUnit: 32 },
  { rateDate: "2026-07-11", currency: "JPY", twdPerUnit: 0.2 },
];
const index = indexExchangeRates(rates);

test("a date between working days uses the newest earlier rate", () => {
  assert.deepEqual(rateOnOrBefore(index, "USD", "2026-07-12"), { rateDate: "2026-07-11", twdPerUnit: 32 });
  assert.deepEqual(rateOnOrBefore(index, "USD", "2026-07-13"), { rateDate: "2026-07-13", twdPerUnit: 33 });
  assert.equal(rateOnOrBefore(index, "USD", "2026-07-10"), null, "no rate before the first rate date");
  assert.deepEqual(rateOnOrBefore(index, "TWD", "1999-01-01"), { rateDate: null, twdPerUnit: 1 });
});

test("amounts convert to one TWD value with the rate dates used", () => {
  assert.deepEqual(
    convertToTwd([{ currency: "TWD", value: 100 }, { currency: "USD", value: 2 }, { currency: "JPY", value: 1000 }], "2026-07-12", index),
    { value: 100 + 64 + 200, rateDates: ["2026-07-11"] },
  );
  assert.equal(convertToTwd([{ currency: "EUR", value: 1 }], "2026-07-12", index), null, "a currency without any rate cannot convert");
  assert.deepEqual(convertToTwd([], "2026-07-12", index), { value: 0, rateDates: [] });
});
