import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./DailyHistoryTable.svelte", import.meta.url), "utf8");

test("missing exchange rates do not color native-currency daily changes", () => {
  assert.match(
    source,
    /class:amount-positive=\{!row\.exchangeRateMissing && dailyChange > 0\}/,
  );
  assert.match(
    source,
    /class:amount-negative=\{!row\.exchangeRateMissing && dailyChange < 0\}/,
  );
});

test("missing exchange rates stack native currencies with visible copy", () => {
  assert.match(source, /\.replaceAll\(" \/ ", "\\n"\)/);
  assert.match(source, /<tr class:missing-rate-row=\{row\.exchangeRateMissing\}>/);
  assert.match(source, /class="rate-note missing"[\s\S]*\{\$t\.historyTable\.missingExchangeRate\}[\s\S]*<\/span>/);
  assert.match(source, /\.missing-rate-row \.money \{[\s\S]*white-space: pre-line;/);
});

test("any missing exchange rate disables all amount sorting", () => {
  assert.match(source, /\$: hasMissingRates = rows\.some\(\(row\) => row\.exchangeRateMissing === true\);/);
  assert.match(source, /if \(hasMissingRates && sortKey !== "date"\)/);
  assert.match(source, /sortDisabled = column\.key !== "date" && hasMissingRates/);
  assert.match(source, /disabled=\{sortDisabled\}/);
});
