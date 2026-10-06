import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveOverview } from "../shared-shell/progressive-dashboard-data.ts";
import type { OverviewPageDto } from "./types.ts";

const source = readFileSync(new URL("./OverviewDashboard.svelte", import.meta.url), "utf8");
const bannerSource = readFileSync(
  new URL("../shared-shell/components/EmptySourceBanner.svelte", import.meta.url),
  "utf8",
);

const base: OverviewPageDto = {
  availability: "available",
  coverage: "complete",
  historyAvailability: "unavailable",
  sourceGaps: [],
  importedAt: null,
  summary: [],
  dailyHistory: [],
  dailyHistoryByAccount: {},
  accounts: [],
  holdingPrices: [],
  exchangeRates: [],
};

test("every card reads one model built from the route DTO and its loaded blocks", () => {
  assert.match(source, /\$: data = resolveOverview\(overview, \{/);
  assert.match(source, /\$: model = readOverview\(data, \{ today: dateInTimeZone\(new Date\(\), \$systemTimezone\) \}\)/);
  const history = [{
    date: "2026-09-22",
    netAssets: [{ currency: "USD", value: 10 }],
    dailyChange: [],
    assets: [{ currency: "USD", value: 10 }],
    liabilities: [],
    accountChanges: [],
    positionCount: 0,
  }];
  const resolved = resolveOverview(base, { list: { ...base, dailyHistory: history, dailyHistoryByAccount: { account: history } } });
  assert.deepEqual(resolved.dailyHistory, history);
  assert.deepEqual(resolved.dailyHistoryByAccount, { account: history });
});

test("the daily detail modal receives TWD rows converted per date", () => {
  assert.match(source, /<DailyHistoryModal bind:open=\{detailOpen\} rows=\{model\.historyRows\} \/>/);
  assert.doesNotMatch(source, /DailyHistoryTable/, "the dashboard never hands native rows to the table");
});

test("overview keeps its onboarding spotlight targets", () => {
  assert.match(source, /export let onboardingEmptyState = false/);
  assert.match(source, /id: "overview\.summary"/);
  assert.match(
    source,
    /\{#if awaitingData\}[\s\S]*?<EmptySourceBanner[\s\S]*?onboardingTargetId="overview\.empty"/,
    "the empty state's call to action is the spotlight target",
  );
  assert.match(
    bannerSource,
    /href="#\/automation"[\s\S]*?registerOnboardingTarget=\{\{ registry: onboardingTargets, id: onboardingTargetId \}\}/,
    "the banner registers its automation link as the target",
  );
  const coverageProjectionState = source.slice(
    source.indexOf('overview.coverage !== "complete" && !awaitingData'),
    source.indexOf("\n      </div>\n    {/if}", source.indexOf('overview.coverage !== "complete" && !awaitingData')),
  );
  assert.match(coverageProjectionState, /id: onboardingEmptyState \? "overview\.empty" : null/);
  assert.match(coverageProjectionState, /class="projection-gap-list"[\s\S]*safeSourceGapLabel\(gap\)/);
  assert.doesNotMatch(source, /data-onboarding/);
});

test("unavailable current state wins when source gaps are also present", () => {
  const stateExpression = source.slice(
    source.indexOf("$: currentStateLabel"),
    source.indexOf(";", source.indexOf("$: currentStateLabel")),
  );
  assert.match(stateExpression, /overview\.availability === "unavailable"\s*\?\s*\$t\.overview\.currentUnavailable/);
  assert.ok(
    stateExpression.indexOf('overview.availability === "unavailable"') <
      stateExpression.indexOf("overview.sourceGaps.length > 0"),
  );
});

test("overview does not render balance-basis notices", () => {
  assert.doesNotMatch(source, /usesAvailableBalance|usesEstimatedCredit|data-balance-basis=/);
});
