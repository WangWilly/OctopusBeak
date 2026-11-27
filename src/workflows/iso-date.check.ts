import assert from "node:assert/strict";
import test from "node:test";
import { nextIsoDate } from "./iso-date.ts";

test("nextIsoDate steps one UTC calendar day across month, year and leap-day boundaries", () => {
  assert.equal(nextIsoDate("2026-03-14"), "2026-03-15");
  assert.equal(nextIsoDate("2026-04-30"), "2026-05-01");
  assert.equal(nextIsoDate("2026-12-31"), "2027-01-01");
  assert.equal(nextIsoDate("2024-02-28"), "2024-02-29");
  assert.equal(nextIsoDate("2024-02-29"), "2024-03-01");
  assert.equal(nextIsoDate("2026-02-28"), "2026-03-01");
});

test("nextIsoDate throws on a value that is not a calendar date", () => {
  assert.throws(() => nextIsoDate("2026/03/14"), RangeError);
  assert.throws(() => nextIsoDate(""), RangeError);
});
