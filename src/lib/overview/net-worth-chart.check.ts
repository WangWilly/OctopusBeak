import assert from "node:assert/strict";
import test from "node:test";
import { dayOffset, monthTicks, niceTicks } from "./net-worth-chart.ts";

test("axis ticks are round and cover the data", () => {
  const ticks = niceTicks(1_690_000, 2_150_000, 6);
  assert.deepEqual(ticks, [1_600_000, 1_700_000, 1_800_000, 1_900_000, 2_000_000, 2_100_000, 2_200_000]);
  const flat = niceTicks(500, 500);
  assert.ok(flat[0]! <= 500 && flat.at(-1)! >= 500, "a flat series still gets a range around it");
});

test("each month is labelled once at its first point", () => {
  const ticks = monthTicks([
    { date: "2026-06-08", value: 1 },
    { date: "2026-06-20", value: 1 },
    { date: "2026-07-01", value: 1 },
    { date: "2026-09-02", value: 1 },
  ]);
  assert.deepEqual(ticks.map((tick) => tick.date), ["2026-06-08", "2026-07-01", "2026-09-02"]);
});

test("x positions follow calendar days, not point count", () => {
  assert.equal(dayOffset("2026-09-30", "2026-10-02"), 2);
});
