import assert from "node:assert/strict";
import { buildCenteredSparklineYAxis } from "./sparkline-format.ts";

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
