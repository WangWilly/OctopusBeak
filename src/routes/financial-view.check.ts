import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

test("product routes load primary and secondary sections instead of the full page loaders", () => {
  for (const product of ["overview", "assets", "liabilities", "spending"]) {
    assert.match(source, new RegExp(`window\\.octopusBeak\\.${product}\\.loadSection\\(\\"primary\\"`));
    assert.match(source, new RegExp(`window\\.octopusBeak\\.${product}\\.loadSection\\(\\"secondary\\"`));
    assert.doesNotMatch(source, new RegExp(`window\\.octopusBeak\\.${product}\\.load\\(`));
  }
});

test("the renderer exposes the progressive generation invariants", () => {
  assert.match(source, /DashboardShell active="overview"/);
  assert.match(source, /matchingSecondary/);
  assert.match(source, /financial-section-knowledge-point-mismatch/);
  assert.match(source, /secondary: \{ status: "loading"/);
  assert.match(source, /if \(secondaryResult\) applySecondary\(secondaryResult\)/);
  assert.match(source, /!options\.force\s*&&\s*!options\.background/);
  assert.match(source, /secondaryError = error;\s*applySecondaryError\(error\)/);
  assert.match(source, /if \(!primarySettled && background\) return/);
  assert.match(source, /data-secondary-ready/);
  assert.match(source, /route === next && !signal\?\.aborted/);
  assert.match(source, /Primary.*generation|new primary generation invalidates the old secondary/u);
});

test("old secondary data is not composed across a primary knowledge point", () => {
  assert.match(
    source,
    /state\.secondary\.status === "ready"\s*&&\s*state\.secondary\.knowledgePoint === state\.primary\.knowledgePoint/,
  );
  assert.match(source, /dailyHistoryByAccount: secondary\?\.dailyHistoryByAccount \?\? \{\}/);
  assert.match(source, /purchaseReport: secondary\?\.purchaseReport \?\? state\.primary\.data\.purchaseReport/);
});
