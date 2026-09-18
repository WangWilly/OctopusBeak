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
  assert.match(source, /FinancialSecondaryFallback/);
  assert.match(source, /route === next && !signal\?\.aborted/);
  assert.match(source, /Primary.*generation|new primary generation invalidates the old secondary/u);
  assert.match(source, /window\.octopusBeak\.financial\.cancel\(requestToken\)/);
  assert.match(source, /options\.signal\?\.addEventListener\("abort", cancelRead/);
  assert.match(source, /options\.signal\?\.removeEventListener\("abort", cancelRead/);
  assert.match(source, /stableFinancialErrorCode\(error\)/);
  assert.doesNotMatch(source, /console\.warn\([^\n]*,\s*error\)/);
  assert.doesNotMatch(source, /return error instanceof Error \? error\.message/);
});

test("old secondary data is not composed across a primary knowledge point", () => {
  assert.match(
    source,
    /state\.secondary\.status === "ready"\s*&&\s*state\.secondary\.knowledgePoint === state\.primary\.knowledgePoint/,
  );
  assert.match(source, /dailyHistoryByAccount: secondary\?\.dailyHistoryByAccount \?\? \{\}/);
  assert.match(source, /purchaseReport: secondary\?\.purchaseReport \?\? state\.primary\.data\.purchaseReport/);
});

test("spending invoices are composed only from a matching secondary generation", () => {
  assert.match(source, /invoices: secondary\?\.invoices \?\? state\.primary\.data\.invoices/);
  assert.match(
    source,
    /function matchingSecondary[\s\S]*?state\.secondary\.knowledgePoint === state\.primary\.knowledgePoint[\s\S]*?function spendingPage[\s\S]*?invoices: secondary\?\.invoices \?\? state\.primary\.data\.invoices/,
  );
});

test("a primary failure renders section-specific secondary data without enabling writes", () => {
  assert.match(source, /FinancialSecondaryFallback kind="overview" data=\{overview\.secondary\.data\}/);
  assert.match(source, /FinancialSecondaryFallback kind="assets" data=\{assets\.secondary\.data\}/);
  assert.match(source, /FinancialSecondaryFallback kind="liabilities" data=\{liabilities\.secondary\.data\}/);
  assert.match(source, /FinancialSecondaryFallback kind="spending" data=\{spending\.secondary\.data\}/);
  assert.match(source, /sanitizedFinancialError\(error/);
  assert.match(source, /const activeRequest = requestToken !== undefined/);
  assert.match(source, /if \(!activeRequest\) return/);
  assert.doesNotMatch(source, /refreshError: message\(error\)/);
  assert.doesNotMatch(source, /refreshError: error/);
  assert.doesNotMatch(source, /primary: \{ status: "error", message: message\(error\)/);
  assert.doesNotMatch(source, /console\.warn\([^\n]*,\s*error\)/);
});
