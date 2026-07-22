import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appCss = readFileSync(new URL("../../../app.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./StackedBalanceChart.svelte", import.meta.url), "utf8");

test("balance chart tooltips can escape the chart padding", () => {
  assert.match(appCss, /\.balance-chart\s*\{[^}]*overflow:\s*visible;/);
});

assert.match(source, /formatUtcDate\(new Date\(value\)\.toISOString\(\), \$systemTimezone, \$locale\)/);
assert.match(source, /x="position"/);
assert.match(source, /xValues = axisTimes\.map\(\(_, index\) => String\(index\)\)/);
assert.match(source, /xDomain = xValues;/);
assert.match(source, /tickSpacing: 80/);
assert.match(source, /tooltipContext=\{\{ mode: "band" \}\}/);
assert.match(source, /\.stacked-balance-chart :global\(\.lc-layout-svg\)\s*\{[^}]*overflow:\s*hidden;/);
assert.match(source, /isSingleSeriesSelected = selectedSeriesKeys\.length === 1;/);
assert.match(source, /buildSparklineYAxis\(\[0, \.\.\.visibleChart\.totals\.map\(\(point\) => point\.value\)\]\)/);
assert.match(source, /yDomain = isSingleSeriesSelected \? \[yAxis\.min, yAxis\.max\] : \[0, yAxis\.max\];/);
assert.match(source, /yBaseline=\{isSingleSeriesSelected \? null : 0\}/);
assert.match(source, /transform=\{\{ mode: "domain", axis: "x" \}\}/);
assert.match(source, /brush=\{\{ axis: "y", clickToReset: true, onBrushEnd: trackYRange \}\}/);
assert.match(source, /let brushedYDomain: \[number, number\] \| null = null;/);
assert.match(source, /function trackYRange\(\{ brush \}: \{ brush: \{ active\?: boolean; y: Array<number \| Date \| string \| null> \} \}\) \{/);
assert.match(source, /brushedYDomain = \[Math\.min\(start, end\), Math\.max\(start, end\)\];/);
assert.match(source, /yDomain=\{brushedYDomain \?\? yDomain\}/);
assert.match(source, /function resetYRange\(\) \{/);
assert.match(source, /\{#if hasYRange\}/);
assert.match(source, /\{\$t\.spending\.chartReset\}/);
assert.match(source, /\{#key `\$\{chart\.signature\}:\$\{selectedSeriesKeys\.join\(","\)\}:\$\{yRangeReset\}`\}/);
assert.match(source, /class="stacked-balance-tooltip-swatch" style:background-color=\{item\.color\}/);
assert.match(source, /\.stacked-balance-tooltip-swatch\s*\{[^}]*border-radius:\s*999px;/);
assert.match(source, /function orderedTooltipSeries\(\) \{/);
assert.match(source, /return \[\.\.\.visibleChart\.series\]\.reverse\(\);/);
assert.match(source, /\{#each orderedTooltipSeries\(\) as item\}/);
assert.doesNotMatch(source, /adjustYAxis/);
assert.match(source, /return typeof value === "number" \? formatSparklineTick\(value\) : String\(value\);/);
assert.doesNotMatch(source, /\byTicks\b/);
assert.doesNotMatch(source, /\bticks:/);
assert.match(source, /<div class="stacked-balance-stage" role="img" aria-label=\{ariaLabel\}>/);
