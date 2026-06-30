import assert from "node:assert/strict";
import { buildSparklineYAxis, formatSparklineTick } from "./sparkline-format.ts";

assert.deepEqual(
  [2_641_397, 2_436_574, 2_231_751].map((value) => formatSparklineTick(value)),
  ["2.6M", "2.4M", "2.2M"],
);

const debtAxis = buildSparklineYAxis([1_554_043, 1_568_164]);

assert.deepEqual(debtAxis.ticks.map((tick) => formatSparklineTick(tick, debtAxis.step)), [
  "1.575M",
  "1.568M",
  "1.561M",
  "1.554M",
  "1.547M",
]);
assert.equal(debtAxis.min, 1_546_982.5);
assert.equal(debtAxis.max, 1_575_224.5);
