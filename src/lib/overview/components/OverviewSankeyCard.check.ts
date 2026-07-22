import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./OverviewSankeyCard.svelte", import.meta.url), "utf8");

test("overview Sankey card uses LayerChart Sankey with node and link tooltips", () => {
  assert.match(source, /import \{ Chart, Group, Layer, Link, Rect, Text, Tooltip \} from "layerchart";/);
  assert.match(source, /import \{ Sankey \} from "layerchart\/graph";/);
  assert.match(source, /<Sankey nodeId=\{\(node\) => node\.id\}/);
  assert.match(source, /onpointermove=\{\(event\) => context\.tooltip\.show\(event, \{ link \}\)\}/);
  assert.match(source, /onpointermove=\{\(event\) => context\.tooltip\.show\(event, \{ node \}\)\}/);
  assert.match(source, /aria-label=\{\$t\.overview\.portfolioFlow\}/);
  assert.doesNotMatch(source, /\.data\.(id|label|tone)/);
  assert.match(source, /function labelFor\(value: string\)/);
  assert.match(source, /function chartHeightFor\(nodes: OverviewSankeyGraphDto\["nodes"\]\)/);
  assert.match(source, /height=\{chartHeight\}/);
  assert.match(source, /\{#if nodeHeight >= 14\}/);
  assert.match(source, /export let twdPerUnit = 1;/);
  assert.match(source, /\$: displayGraph = twdPerUnit === 1 \? graph : \{[\s\S]*value: link\.value \/ twdPerUnit/);
});
