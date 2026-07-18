import assert from "node:assert/strict";
import {
  formatUtcDateTime,
  formatUtcDate,
  isIanaTimezone,
  zonedDateTimeToUtc,
} from "./timezone.ts";

assert.equal(isIanaTimezone("Asia/Taipei"), true);
assert.equal(isIanaTimezone("not/a-zone"), false);
assert.equal(zonedDateTimeToUtc("2026-07-15", "12:34:56", "Asia/Taipei"), "2026-07-15T04:34:56.000Z");
assert.equal(zonedDateTimeToUtc("2026-03-08", "03:30:00", "America/New_York"), "2026-03-08T07:30:00.000Z");
assert.equal(formatUtcDateTime("2026-07-15T04:34:56.000Z", "Asia/Taipei", "zh-TW"), "2026/07/15 12:34:56");
assert.equal(formatUtcDateTime("2026-07-15T12:34:56+08:00", "Asia/Taipei", "zh-TW"), "2026/07/15 12:34:56");
assert.equal(formatUtcDateTime("2026-07-15", "Asia/Taipei", "zh-TW"), "2026-07-15");
assert.equal(formatUtcDate("2026-07-15T16:34:56.000Z", "Asia/Taipei", "zh-TW"), "2026/07/16");
assert.equal(formatUtcDate("2026-07-15", "America/Los_Angeles", "zh-TW"), "2026/07/15");
assert.throws(() => formatUtcDateTime("2026-07-15T04:34:56", "Asia/Taipei", "zh-TW"));
assert.throws(() => zonedDateTimeToUtc("2026-02-30", "12:00:00", "Asia/Taipei"));
assert.throws(() => zonedDateTimeToUtc("2026-03-08", "02:30:00", "America/New_York"));
assert.throws(() => zonedDateTimeToUtc("2026-11-01", "01:30:00", "America/New_York"));
