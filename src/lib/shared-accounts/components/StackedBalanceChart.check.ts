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
assert.match(source, /transform=\{\{ mode: "domain", axis: "x" \}\}/);
assert.match(source, /tooltipContext=\{\{ mode: "band" \}\}/);
assert.match(source, /\.stacked-balance-chart :global\(\.lc-layout-svg\)\s*\{[^}]*overflow:\s*hidden;/);
