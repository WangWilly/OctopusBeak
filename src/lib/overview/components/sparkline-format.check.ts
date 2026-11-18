import assert from "node:assert/strict";
import test from "node:test";
import { buildCenteredSparklineYAxis, buildStackedYAxis, buildTrendYAxis } from "./sparkline-format.ts";

assert.deepEqual(buildTrendYAxis([0, 100]), {
  min: -12,
  max: 112,
  step: 31,
  ticks: [-12, 19, 50, 81, 112],
});

assert.deepEqual(buildCenteredSparklineYAxis([120, 160, -50]), {
  min: -240,
  max: 240,
  step: 120,
  ticks: [240, 120, 0, -120, -240],
});

assert.deepEqual(buildCenteredSparklineYAxis([0]), {
  min: -2,
  max: 2,
  step: 1,
  ticks: [2, 1, 0, -1, -2],
});

test("a stacked balance axis tops out just above the tallest total", () => {
  const axis = buildStackedYAxis([1_470_000, 1_550_000, 1_490_000, Number.NaN]);
  assert.equal(axis.min, 0);
  assert.equal(axis.max, 1_550_000 * 1.08, "8% headroom above the tallest total");
  assert.equal(axis.step, axis.max / 4, "tick labels keep the precision of a quarter of the axis");
  assert.equal(buildStackedYAxis([0, 0]).max, 1, "an all-zero stack still has a drawable axis");
});
