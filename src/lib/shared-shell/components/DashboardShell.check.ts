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
