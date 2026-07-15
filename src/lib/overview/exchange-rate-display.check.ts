import assert from "node:assert/strict";
import type { DailyHistoryRowDto, ExchangeRateDto } from "../shared-ledger/types.ts";
import {
  convertDailyHistoryRows,
  dailyHistoryCurrencies,
} from "./exchange-rate-display.ts";

const rows: DailyHistoryRowDto[] = [{
  date: "2026-07-12",
  netAssets: [
    { currency: "TWD", value: 3200 },
    { currency: "USD", value: 100 },
  ],
  dailyChange: [{ currency: "USD", value: 10 }],
  assets: [{ currency: "JPY", value: 1000 }],
  liabilities: [{ currency: "TWD", value: 640 }],
  accountChanges: ["USD account"],
  positionCount: 3,
}];
const rates: ExchangeRateDto[] = [
  { rateDate: "2026-07-11", currency: "USD", twdPerUnit: 32 },
  { rateDate: "2026-07-11", currency: "JPY", twdPerUnit: 0.2 },
  { rateDate: "2026-07-13", currency: "USD", twdPerUnit: 33 },
  { rateDate: "2026-07-13", currency: "JPY", twdPerUnit: 0.21 },
];

assert.deepEqual(dailyHistoryCurrencies(rows), ["TWD", "USD", "JPY"]);
const converted = convertDailyHistoryRows(rows, rates, "USD");
assert.deepEqual(converted.rows[0]?.netAssets, [{ currency: "USD", value: 200 }]);
assert.deepEqual(converted.rows[0]?.dailyChange, [{ currency: "USD", value: 10 }]);
assert.deepEqual(converted.rows[0]?.assets, [{ currency: "USD", value: 6.25 }]);
assert.deepEqual(converted.rows[0]?.liabilities, [{ currency: "USD", value: 20 }]);
assert.deepEqual(converted.rows[0]?.exchangeRateDates, ["2026-07-11"]);
assert.equal(converted.rows[0]?.exchangeRateMissing, false);
assert.deepEqual(converted.rows[0]?.accountChanges, ["USD account"]);
assert.equal(converted.rows[0]?.positionCount, 3);

const missing = convertDailyHistoryRows(rows, rates.filter((rate) => rate.currency !== "JPY"), "USD");
assert.equal(missing.rows[0]?.exchangeRateMissing, true);
assert.deepEqual(missing.rows[0]?.assets, rows[0]?.assets);
assert.deepEqual(missing.rows[0]?.netAssets, rows[0]?.netAssets);

let currencyReads = 0;
const manyRates = Array.from({ length: 200 }, (_, index): ExchangeRateDto => new Proxy({
  rateDate: `2026-06-${String(index % 28 + 1).padStart(2, "0")}`,
  currency: index % 2 === 0 ? "USD" : "JPY",
  twdPerUnit: index % 2 === 0 ? 32 : 0.2,
}, {
  get(target, property, receiver) {
    if (property === "currency") currencyReads += 1;
    return Reflect.get(target, property, receiver);
  },
}));
convertDailyHistoryRows(Array.from({ length: 20 }, () => rows[0]!), manyRates, "USD");
assert.ok(
  currencyReads <= manyRates.length,
  `expected rates to be grouped once, read currency ${currencyReads} times for ${manyRates.length} rates`,
);
