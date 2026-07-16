import assert from "node:assert/strict";
import {
  spendingChartInteractionProps,
  spendingChartViewport,
} from "./spending-chart-interaction.ts";

assert.equal(spendingChartViewport(0, 1000, 1, 0), null);
assert.deepEqual(spendingChartViewport(24, 1000, 1, 0), {
  startIndex: 0,
  endIndex: 23,
  atStart: true,
  atEnd: true,
});
assert.deepEqual(spendingChartViewport(24, 1000, 2, 0), {
  startIndex: 0,
  endIndex: 11,
  atStart: true,
  atEnd: false,
});
assert.deepEqual(spendingChartViewport(24, 1000, 2, -1000), {
  startIndex: 12,
  endIndex: 23,
  atStart: false,
  atEnd: true,
});

assert.deepEqual(spendingChartInteractionProps("static"), { brush: false, transform: undefined });
assert.deepEqual(spendingChartInteractionProps("brush"), {
  brush: { axis: "x", minExtent: { x: 2 }, zoomOnBrush: false },
  transform: undefined,
});
assert.deepEqual(spendingChartInteractionProps("pan-zoom"), {
  brush: false,
  transform: {
    mode: "domain",
    axis: "x",
    scrollMode: "scale",
    scrollActivationKey: "meta",
    scaleExtent: [1, 6],
  },
});
assert.deepEqual(spendingChartInteractionProps("brush-pan-zoom"), {
  brush: { axis: "x", minExtent: { x: 2 } },
  transform: {
    mode: "domain",
    axis: "x",
    scrollMode: "scale",
    scrollActivationKey: "meta",
    scaleExtent: [1, 6],
  },
});
