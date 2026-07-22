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

test("overview renders the Sankey prototype below the daily history", () => {
  assert.match(
    source,
    /import OverviewSankeyCard from "\$lib\/overview\/components\/OverviewSankeyCard\.svelte";/,
  );
  assert.match(
    source,
    /import \{ overviewSankeyPrototype \} from "\$lib\/overview\/components\/overview-sankey-data\.ts";/,
  );
  assert.match(source, /const sankeyPrototype = overviewSankeyPrototype\(\);/);
  assert.match(source, /<OverviewSankeyCard graph=\{sankeyPrototype\} currency="TWD" \/>/);
});

assert.match(source, /formatUtcDateTime\(value, \$systemTimezone, \$locale\)/);
