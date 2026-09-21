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

test("refresh route loaders carry one generation and isolate first-run failures", () => {
  assert.match(source, /overview: \(snapshot\) => loadRoute\("overview",[\s\S]*snapshot/);
  assert.match(source, /expectedVersion: options\.snapshot\.version/);
  assert.match(source, /settleIndependentLoads\(/);
  assert.doesNotMatch(source, /Promise\.all\(\s*\[\s*routeDataCache\.load/);
});

test("route blocks start before the full route DTO and remain retryable", () => {
  const blockStart = source.search(/startRouteBlockLoads\(\s*next,\s*readOptions/);
  const dtoLoad = source.indexOf("routeDataCache.load(\n          \"overview\"");
  assert.ok(blockStart >= 0, "route load must start independent block reads");
  assert.ok(dtoLoad > blockStart, "block reads must begin before the route DTO");
  assert.match(source, /loadRouteBlock\(nextRoute, key, options\)/);
  assert.doesNotMatch(source, /hydrateRouteBlocks|blockPayload/);
});

test("a settled block can render before the full route DTO and refresh waits for it", () => {
  assert.match(source, /overviewRenderValue = overviewValue \?\? progressiveOverview\(\)/);
  assert.match(source, /<OverviewDashboard\s+overview=\{overviewRenderValue\}/);
  assert.match(source, /if \(options\.awaitBlocks && blockLoads\)/);
  assert.match(source, /const failedBlocks = Object\.entries\(states\)/);
});

test("automation block refreshes are coordinated and stale responses are detected", () => {
  assert.match(source, /createAutomationBlockRefreshCoordinator/);
  assert.match(source, /automationBlockRefreshCoordinator\.refresh\(/);
  assert.match(source, /isAutomationBlockStale\(/);
  assert.match(source, /automationRefreshReason: "route-entry"/);
  assert.match(source, /automationRefreshReason: "manual"/);
  assert.match(source, /automationRefreshReason: "session-resync"/);
  assert.match(source, /refreshPhase !== "trailing"/);
});
