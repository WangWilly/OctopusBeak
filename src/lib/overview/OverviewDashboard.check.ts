import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
  summary: { net: { display: "native", amounts: [], includesPreview: false, incomplete: false }, assets: { amounts: [] }, liabilities: { amounts: [] } },
  dailyHistory: [],
  dailyHistoryByAccount: {},
  accounts: [],
  holdingPrices: [],
  exchangeRates: [],
};

test("every card reads one model built from the live overview page", () => {
  assert.doesNotMatch(source, /blocks|ProgressiveBlock|resolveOverview/);
  assert.match(source, /\$: model = readOverview\(overview, \{ today: dateInTimeZone\(new Date\(\), \$systemTimezone\) \}\)/);
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
  const unavailableProjectionState = source.slice(
    source.indexOf('overview.coverage === "unavailable" && !awaitingData'),
    source.indexOf("\n      </div>\n    {/if}", source.indexOf('overview.coverage === "unavailable" && !awaitingData')),
  );
  assert.match(unavailableProjectionState, /id: onboardingEmptyState \? "overview\.empty" : null/);
  assert.doesNotMatch(source, /data-onboarding/);
});

test("overview leaves incomplete collection to the automation run details", () => {
  assert.doesNotMatch(source, /sourceGaps|currentPartial|projection-gap-list|safeSourceGapLabel/);
  assert.match(source, /\{#if overview\.coverage === "unavailable" && !awaitingData\}[\s\S]*?\$t\.overview\.currentUnavailable/);
});

test("overview does not render balance-basis notices", () => {
  assert.doesNotMatch(source, /usesAvailableBalance|usesEstimatedCredit|data-balance-basis=/);
});

test("an incomplete Net position or Liabilities metric replaces its figure with the incomplete copy", () => {
  assert.match(source, /\bnet = overview\.summary\.net;/);
  assert.match(source, /liabilitiesMetric = overview\.summary\.liabilities;/);
  assert.match(source, /sideValue = net\.incomplete\s*\? \$t\.preview\.incomplete/);
  assert.match(source, /<NetWorthCard[\s\S]*?incomplete=\{net\.incomplete\}/);
  assert.match(source, /state="liabilities"[\s\S]*?incomplete=\{liabilitiesMetric\.incomplete === true\}/);
});
