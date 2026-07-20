import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations } from "../../i18n/i18n.ts";

const source = readFileSync(new URL("./AccountTable.svelte", import.meta.url), "utf8");

test("unavailable account balances render explicit localized copy", () => {
  assert.equal(translations["zh-TW"].accounts.unavailable, "無可用資料");
  assert.match(source, /\{#if account\.valueAvailability === "unavailable"\}\s*\{\$t\.accounts\.unavailable\}\s*\{:else\}\s*\{formatAmountLines\(account\.amountLines\)\}\s*\{\/if\}/);
});
