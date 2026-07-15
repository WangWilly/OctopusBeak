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
