import assert from "node:assert/strict";
import { spendingChartInteractionProps } from "./spending-chart-interaction.ts";

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
