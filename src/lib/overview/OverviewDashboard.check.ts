import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./OverviewDashboard.svelte", import.meta.url), "utf8");

test("daily FX selector is replaced only when every TWD conversion fails", () => {
  assert.match(
    source,
    /\$: twdDailyHistory = convertDailyHistoryRows\(\s*history,\s*overview\.exchangeRates,\s*"TWD",\s*\)\.rows;/,
  );
  assert.match(
    source,
    /\$: allDailyRatesMissing = allExchangeRatesMissing\(twdDailyHistory\);/,
  );
  assert.match(
    source,
    /\{#if allDailyRatesMissing\}[\s\S]*exchangeRatesMissingNative[\s\S]*\{:else if dailyCurrencies\.length > 1\}[\s\S]*daily-base-currency/,
  );
});

test("overview renders the production Sankey graph with the existing base-currency controls", () => {
  assert.match(source, /\{#if overview\.sankey\}/);
  assert.match(source, /id="sankey-base-currency"/);
  assert.match(source, /\$t\.overview\.exchangeRatesThrough\(overview\.latestExchangeRateDate\)/);
  assert.match(source, /<OverviewSankeyCard graph=\{overview\.sankey\} currency=\{sankeyCurrency\} twdPerUnit=\{sankeyTwdPerUnit\} \/>/);
  assert.match(source, /class="card sankey-card"/);
  assert.doesNotMatch(source, /overviewSankeyPrototype/);
});

assert.match(source, /formatUtcDateTime\(value, \$systemTimezone, \$locale\)/);
