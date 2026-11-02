import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./DashboardShell.svelte", import.meta.url), "utf8");

test("DashboardShell exposes the global refresh state and keeps it interactive", () => {
  assert.match(source, /data-refresh-state=\{\$refreshState\.status\}/);
  assert.match(source, /aria-busy=\{\$refreshState\.status === "refreshing"\}/);
  assert.match(source, /disabled=\{!refreshContext \|\| \$refreshState\.status === "refreshing"\}/);
  assert.match(source, /onClick|onclick=\{\(\) => refreshContext && void refreshContext\.refresh\(\)\}/);
  assert.doesNotMatch(source, /data-onboarding|syncDataOnboarding/);
});

test("the sidebar shows update downloads under the nav, and Restart to update waits for runs", () => {
  assert.match(source, /<\/nav>[\s\S]*?<AppUpdateSidebar collapsed=\{sidebarCollapsed\} \/>[\s\S]*?<\/aside>/);
  const sidebar = readFileSync(new URL("./AppUpdateSidebar.svelte", import.meta.url), "utf8");
  assert.match(sidebar, /role="progressbar"[\s\S]*?aria-valuenow=\{percent\}/);
  assert.match(sidebar, /id="app-update-restart"[\s\S]*?disabled=\{restartBlocked \|\| pending\}/);
  assert.match(sidebar, /\$: restartBlocked = \$runActive;/, "a refused restart does not keep the button disabled");
  assert.match(sidebar, /\$: showRunActive = \$runActive \|\| \(restartResult\?\.ok === false && restartResult\.reason === "run-active"\)/);
});

test("the side figure shows the markers of every origin it counts", () => {
  assert.match(source, /export let sideProvenance: Provenance = NO_PROVENANCE;/);
  assert.match(source, /\{#if hasProvenance\(sideProvenance\)\}[\s\S]*?<OriginMarkers provenance=\{sideProvenance\} placement="above" \/>/);
  const markers = readFileSync(new URL("./OriginMarkers.svelte", import.meta.url), "utf8");
  assert.match(markers, /\{#if provenance\.preview\}<PreviewMarker \{placement\} \{align\} \/>\{\/if\}/);
  assert.match(markers, /\{#if provenance\.manual\}<ManualMarker \{placement\} \{align\} \/>\{\/if\}/);
});
