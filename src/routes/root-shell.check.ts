import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

test("route root renders a shell fallback before a route DTO is ready", () => {
  assert.doesNotMatch(source, /if !initialized/);
  assert.match(source, /<DashboardShell active="overview"/);
  assert.match(source, /<RouteLoadFallback state=\{overview\}/);
  assert.match(source, /<RouteLoadNotice state=\{overview\}/);
});

test("financial page refreshes use live views and isolate first-run failures", () => {
  assert.match(source, /overview: \(snapshot\) => loadRoute\("overview",[\s\S]*snapshot/);
  assert.match(source, /expectedVersion: options\.snapshot\.version/);
  assert.match(source, /settleIndependentLoads\(/);
  assert.match(source, /await reloadFinancialLive\("overview"\)/);
  assert.match(source, /await reloadFinancialLive\(next\)/);
  assert.doesNotMatch(source, /Promise\.all\(\s*\[\s*routeDataCache\.load/);
});

test("financial pages are live-only and synthesize ready dashboard blocks", () => {
  assert.match(source, /createFinancialPageLiveStores\(window\.octopusBeak\.dataViews\)/);
  assert.match(source, /PGlite financial page views are unavailable/);
  assert.match(source, /readyDashboardBlock\("overview", "summary"/);
  assert.match(source, /readyDashboardBlock\("assets", "summary"/);
  assert.match(source, /readyDashboardBlock\("liabilities", "summary"/);
  assert.match(source, /readyDashboardBlock\("spending", "summary"/);
  assert.doesNotMatch(source, /octopusBeak\.(overview|assets|liabilities|spending)\.(load|loadBlock)\(/);
  assert.match(source, /return window\.octopusBeak\.automation\.loadBlock\(key, options\)/);
});

test("a PGlite page DTO makes every dashboard section renderable", () => {
  assert.match(source, /overviewRenderValue = overviewValue/);
  assert.match(source, /<OverviewDashboard\s+overview=\{overviewRenderValue\}/);
  assert.match(source, /setRouteBlocks\(nextRoute, setValue\(state\.data\)\)/);
  assert.match(source, /<SpendingDashboard\s+spending=\{spendingRenderValue\}/);
});

test("automation block refreshes are coordinated and stale responses are detected", () => {
  assert.match(source, /createAutomationBlockRefreshCoordinator/);
  assert.match(source, /automationBlockRefreshCoordinator\.refresh\(/);
  assert.match(source, /isAutomationBlockStale\(/);
  assert.match(source, /automationRefreshReason: "route-entry"/);
  assert.match(source, /automationRefreshReason: "manual"/);
  assert.match(source, /automationRefreshReason: "session-resync"/);
  assert.match(source, /refreshPhase !== "trailing"/);
  assert.match(source, /routeDataCache\.load\("automation"/);
});
