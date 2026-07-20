import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations } from "../../i18n/i18n.ts";

const source = readFileSync(new URL("./AccountTable.svelte", import.meta.url), "utf8");

test("unavailable account balances render explicit localized copy", () => {
  assert.equal(translations["zh-TW"].accounts.unavailable, "無可用資料");
  assert.match(source, /\{#if account\.valueAvailability === "unavailable"\}[\s\S]*\$t\.accounts\.noAvailableData[\s\S]*#\/data-issues\/\$\{account\.dataIssueId\}[\s\S]*\{:else\}\s*\{formatAmountLines\(account\.amountLines\)\}\s*\{\/if\}/);
});

test("unavailable accounts omit allocation and exposure values", () => {
  assert.match(source, /<td class="right">\s*\{#if account\.valueAvailability === "available"\}\s*<span class="account-meta">\{percent\}%<\/span>[\s\S]*?<div class="row-bar"/);
});

test("account deep links select, scroll, and focus the exact rendered row", () => {
  assert.match(source, /data-account-id=\{account\.id\}/);
  assert.match(source, /tabindex=\{account\.id === selectedAccountId \? 0 : -1\}/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /scrollIntoView/);
});
