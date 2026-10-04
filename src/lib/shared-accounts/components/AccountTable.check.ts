import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations } from "../../i18n/i18n.ts";

const source = readFileSync(new URL("./AccountTable.svelte", import.meta.url), "utf8");

test("unavailable account balances render explicit localized copy", () => {
  assert.equal(translations["zh-TW"].accounts.noAvailableData, "無可用資料");
  assert.match(source, /\{#if account\.valueAvailability === "awaiting"\}[\s\S]*\$t\.overview\.currentAwaiting[\s\S]*\{:else if account\.valueAvailability === "unavailable"\}[\s\S]*\$t\.accounts\.noAvailableData[\s\S]*\{:else\}\s*\{formatAmountLines\(account\.amountLines\)\}\s*\{\/if\}/);
  assert.doesNotMatch(source, /data-issues|dataIssueId/);
});

test("available-only account rows expose their balance basis", () => {
  assert.match(source, /availableBalanceBasis = account\.amountLines\.some/);
  assert.match(source, /trace\.balanceKind === "available"/);
  assert.match(source, /\$t\.accounts\.availableBalanceBasis/);
});

test("credit-card current usage rows expose their estimate basis", () => {
  assert.match(source, /estimatedCreditBasis = account\.amountLines\.some/);
  assert.match(source, /trace\.estimateKind === "estimate"/);
  assert.match(source, /\$t\.accounts\.creditCardEstimateBasis/);
});

test("unavailable accounts omit allocation and exposure values", () => {
  assert.match(source, /<td class="right">\s*\{#if account\.valueAvailability === "available"\}\s*<span class="account-meta num">\{percent\}%<\/span>[\s\S]*?<div class="row-bar"/);
});

test("account actions do not expose a data issue reporting surface", () => {
  assert.doesNotMatch(source, /onReportDataIssue|report-issue|data-issues|dataIssueId/);
});

test("account deep links select, scroll, and focus the exact rendered row", () => {
  assert.match(source, /data-account-id=\{account\.id\}/);
  assert.match(source, /tabindex=\{account\.id === selectedAccountId \? 0 : -1\}/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /scrollIntoView/);
});

test("account deep links reset after focus is cleared", () => {
  assert.match(source, /focusAccountId !== handledFocusAccountId/);
  assert.match(source, /handledFocusAccountId = focusAccountId;\s*if \(focusAccountId\)/);
});

test("liability tables can filter investment-kind margin accounts and expose card statements", () => {
  assert.match(source, /\{ id: "fund" as const, label: \$t\.accounts\.fund \}/);
  assert.match(source, /\{ id: "brokerage" as const, label: \$t\.accounts\.brokerage \}/);
  assert.match(source, /selectedAccount\.creditCard/);
  assert.match(source, /CreditCardStatementsModal/);
});
