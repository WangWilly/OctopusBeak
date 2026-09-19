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
