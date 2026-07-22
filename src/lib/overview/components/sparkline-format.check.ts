import assert from "node:assert/strict";
import { buildCenteredSparklineYAxis, buildTrendYAxis } from "./sparkline-format.ts";

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
