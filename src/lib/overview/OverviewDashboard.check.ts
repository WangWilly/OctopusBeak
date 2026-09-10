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
  assert.match(source, /aria-label=\{\$t\.overview\.portfolioFlowBaseCurrency\}/);
  assert.match(source, /\$t\.overview\.exchangeRatesThrough\(overview\.sankeyLatestExchangeRateDate\)/);
  assert.match(source, /<OverviewSankeyCard[\s\S]*graph=\{overview\.sankey\}[\s\S]*currency=\{sankeyCurrency\}[\s\S]*exchangeRates=\{overview\.sankeyExchangeRates\}/);
  assert.match(source, /class="card sankey-card"/);
  assert.doesNotMatch(source, /overviewSankeyPrototype/);
});

test("overview exposes canonical current and honest history states", () => {
  assert.match(source, /overview\.coverage !== "complete"/);
  assert.match(source, /data-overview-state=\{overview\.coverage\}/);
  assert.match(source, /currentPartial\(gapCounts\.currentValue, gapCounts\.sourceNotCollected\)/);
  assert.match(source, /sourceGapCounts\(overview\.sourceGaps\)/);
  assert.match(source, /class="projection-gap-list"[\s\S]*safeSourceGapLabel\(gap\)/);
  assert.match(source, /overview\.historyAvailability === "unavailable"/);
  assert.match(source, /data-overview-state="history-unavailable"/);
});

test("overview does not render balance-basis notices", () => {
  assert.doesNotMatch(source, /usesAvailableBalance|usesEstimatedCredit/);
  assert.doesNotMatch(source, /data-balance-basis=/);
  assert.doesNotMatch(source, /\$t\.overview\.(availableBalanceBasis|creditCardEstimateBasis)/);
});

test("unavailable current state wins when source gaps are also present", () => {
  const stateExpression = source.slice(
    source.indexOf("$: currentStateLabel"),
    source.indexOf("\n\n  onMount", source.indexOf("$: currentStateLabel")),
  );
  assert.match(
    stateExpression,
    /overview\.availability === "unavailable"\s*\?\s*\$t\.overview\.currentUnavailable/,
  );
  assert.ok(
    stateExpression.indexOf('overview.availability === "unavailable"') <
      stateExpression.indexOf("overview.sourceGaps.length > 0"),
  );
});

assert.match(source, /formatUtcDateTime\(value, \$systemTimezone, \$locale\)/);
