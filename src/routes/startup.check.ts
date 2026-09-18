import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./+page.svelte", import.meta.url), "utf8");

function mountSource() {
  const match = source.match(/onMount\(\(\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(match, "the route must keep one explicit startup lifecycle");
  return match[1];
}

test("mounts the route shell before asynchronous settings and financial reads", () => {
  const mount = mountSource();
  const bootstrap = mount.slice(mount.indexOf("onboardingState = readOnboardingState"));
  const shellReady = bootstrap.indexOf("initialized = true");
  const settingsLoad = bootstrap.indexOf("window.octopusBeak.settings.load");

  assert.notEqual(shellReady, -1);
  assert.notEqual(settingsLoad, -1);
  assert.ok(shellReady < settingsLoad, "shell readiness must not await settings or financial reads");
  assert.match(bootstrap, /normalizeRoute\(\);\s*initialized = true;/);
  assert.match(mount, /addEventListener\("hashchange", onHashChange\)/);
  assert.doesNotMatch(mount, /await resolveFirstRunWelcome/);
});

test("delays route reads until settings are ready without delaying route parsing", () => {
  assert.match(
    source,
    /generationCoordinator\.setVisibleRoute\([^\n]+\);\s*if \(!settingsReady\) return;\s*const load = loadRoute\(route\);/s,
  );
  assert.match(source, /settingsReady = true;\s*generationCoordinator\.start\(\);\s*normalizeRoute\(\);/s);
});

test("late first-run eligibility cannot replace a route selected during startup", () => {
  const welcome = source.match(/async function resolveFirstRunWelcome\([\s\S]*?\n  \}\n\n  type FinancialSectionResultValue/);
  assert.ok(welcome);
  assert.match(welcome[0], /startedAtNavigationEpoch !== routeNavigationEpoch/);
  assert.doesNotMatch(welcome[0], /generationCoordinator\.markRouteLoaded/);
  assert.doesNotMatch(welcome[0], /overview = \{/);
});
