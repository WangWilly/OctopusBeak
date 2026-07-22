import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./OverviewSankeyCard.svelte", import.meta.url), "utf8");

test("overview Sankey card uses LayerChart Sankey with node and link tooltips", () => {
  assert.match(source, /type SankeyNodeState = OverviewSankeyNodeDto & \{/);
  assert.match(source, /import \{ Chart, Group, Layer, Link, Rect, Text, Tooltip, sankeyGraphFromNode \} from "layerchart";/);
  assert.match(source, /import \{ Sankey \} from "layerchart\/graph";/);
  assert.match(source, /<Sankey nodeId=\{\(node\) => node\.id\}/);
  assert.match(source, /onpointermove=\{\(event\) => context\.tooltip\.show\(event, \{ link \}\)\}/);
  assert.match(source, /onpointermove=\{\(event\) => context\.tooltip\.show\(event, \{ node \}\)\}/);
  assert.match(source, /aria-label=\{\$t\.overview\.portfolioFlow\}/);
  assert.match(source, /aria-describedby="overview-sankey-summary"/);
  assert.match(source, /id="overview-sankey-summary"/);
  assert.doesNotMatch(source, /:\s*any/);
  assert.doesNotMatch(source, /\.data\.(id|label|tone)/);
  assert.match(source, /function labelFor\(value: string\)/);
  assert.match(source, /function chartHeightFor\(nodes: OverviewSankeyGraphDto\["nodes"\]\)/);
  assert.match(source, /height=\{chartHeight\}/);
  assert.match(source, /\{#if nodeHeight >= 14\}/);
  assert.match(source, /export let twdPerUnit = 1;/);
  assert.match(source, /formatMoney\(\{ currency, value \}, \{ locale: \$locale \}\)/);
  assert.match(source, /\$: displayGraph = twdPerUnit === 1 \? graph : \{[\s\S]*value: link\.value \/ twdPerUnit/);
  assert.match(source, /\$: chartGraph = selectedNode \? sankeyGraphFromNode\(selectedNode\) : displayGraph;/);
  assert.match(source, /onclick=\{\(\) => selectNode\(node\)\}/);
  assert.match(source, /selectedNode\?\.id === node\.id \|\| !node\.sourceLinks\?\.length/);
  assert.match(source, /flowSummary = chartGraph\.links\.map\(\(link\) =>[\s\S]*→ \$\{labelFor\(graphLabels\.get\(link\.target\) \?\? link\.target\)\}:/);
  assert.match(source, /function percentage\(value: number, total: number\)/);
  assert.match(source, /percentage\(link\.value, data\.node\.value\)/);
});
