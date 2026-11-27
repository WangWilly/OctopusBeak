import assert from "node:assert/strict";
import {
  formatUtcDateTime,
  formatUtcDate,
  isIanaTimezone,
  isTaipeiInstant,
  taipeiDate,
  taipeiInstant,
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
assert.equal(taipeiInstant("2026-07-15T16:34:56.789Z"), "2026-07-16T00:34:56+08:00");
assert.equal(taipeiInstant("2026-07-16T00:34:56+08:00"), "2026-07-16T00:34:56+08:00");
assert.equal(taipeiDate(new Date("2026-10-29T15:59:59Z")), "2026-10-29");
assert.equal(taipeiDate(new Date("2026-10-29T16:00:00Z")), "2026-10-30");
assert.equal(taipeiDate("Wed, 28 Oct 2026 17:30:00 GMT"), "2026-10-29");
assert.throws(() => taipeiInstant("2026-07-15T16:34:56"));

for (const [value, accepted] of [
  ["2026-02-01T10:00:00+08:00", true],
  ["2026-02-01T10:00:00.000+08:00", false],
  ["2026-02-01T10:00:00.5+08:00", false],
  ["2026-02-01T10:00:00Z", false],
  ["2026-02-01T10:00:00.000Z", false],
  ["2026-02-01T10:00:00+09:00", false],
  ["2026-02-30T10:00:00+08:00", false],
  ["2026-02-01T24:00:00+08:00", false],
  ["2026-02-01T10:60:00+08:00", false],
  ["2026-02-01T10:00:60+08:00", false],
  ["2026-13-01T10:00:00+08:00", false],
  ["2028-02-29T10:00:00+08:00", true],
  ["2026-02-29T10:00:00+08:00", false],
  ["2026-02-01 10:00:00+08:00", false],
] as const) assert.equal(isTaipeiInstant(value), accepted, value);
assert.equal(isTaipeiInstant(Date.parse("2026-02-01T10:00:00+08:00")), false, "a number is not an instant text");
for (const instant of [
  "2026-07-15T15:59:59.999Z",
  "2026-07-15T16:00:00.000Z",
  "2026-12-31T16:00:00.000Z",
  "2028-02-28T16:00:01Z",
  "2026-07-16T00:34:56+08:00",
]) assert.ok(isTaipeiInstant(taipeiInstant(instant)), `taipeiInstant(${instant}) is a Taipei instant`);
