import assert from "node:assert/strict";
import { sourceTimezone, sourceTransactionAtUtc } from "./source-timezones.ts";

for (const bank of [
  "cathay",
  "ctbc",
  "fubon",
  "hncb",
  "linebank",
  "post",
  "sinopac",
  "yuanta",
]) {
  assert.equal(sourceTimezone(bank), "Asia/Taipei", bank);
}
assert.equal(sourceTimezone("future-bank"), null);
assert.equal(
  sourceTransactionAtUtc("ctbc", "2026-07-15", "12:02:03"),
  "2026-07-15T04:02:03.000Z",
);
assert.equal(sourceTransactionAtUtc("ctbc", "2026-07-15", null), null);
