import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  constrainSpendingChartTransform,
  spendingChartInteractionProps,
  spendingChartViewport,
} from "./spending-chart-interaction.ts";

const chartSource = readFileSync(new URL("./SpendingBarChart.svelte", import.meta.url), "utf8");

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
assert.deepEqual(constrainSpendingChartTransform(1000, { scale: 2, translate: { x: 250, y: 3 } }), {
  scale: 2,
  translate: { x: 0, y: 0 },
});
assert.deepEqual(constrainSpendingChartTransform(1000, { scale: 2, translate: { x: -1500, y: 3 } }), {
  scale: 2,
  translate: { x: -1000, y: 0 },
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
    scrollActivationKey: "control",
    scaleExtent: [1, 6],
  },
});
assert.deepEqual(spendingChartInteractionProps("brush-pan-zoom"), {
  brush: { axis: "x", minExtent: { x: 2 } },
  transform: {
    mode: "domain",
    axis: "x",
    scrollMode: "scale",
    scrollActivationKey: "control",
    scaleExtent: [1, 6],
  },
});

assert.match(chartSource, /export let interaction: SpendingChartInteraction = "pan-zoom";/);
assert.match(chartSource, /bind:context=\{chartContext\}/);
assert.match(chartSource, /onwheel=\{panWithWheel\}/);
assert.match(chartSource, /event\.deltaX === 0/);
assert.match(chartSource, /\$: renderedRows = rows;/);
