import assert from "node:assert/strict";
import { normalizeCurrencyCode, sqliteAmount } from "./source-csv-parsers.ts";

assert.equal(sqliteAmount("8,054台幣"), 8054);
assert.equal(sqliteAmount("913,727台幣"), 913727);
assert.equal(normalizeCurrencyCode("美金"), "USD");
assert.equal(normalizeCurrencyCode("US/TWD"), "TWD");
assert.equal(normalizeCurrencyCode("0台幣", "USD"), "TWD");
