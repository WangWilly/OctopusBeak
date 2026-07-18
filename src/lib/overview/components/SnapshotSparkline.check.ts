import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SnapshotSparkline.svelte", import.meta.url), "utf8");

assert.match(source, /x="position"/);
assert.match(source, /xValues = axisTimes\.map\(\(_, index\) => String\(index\)\)/);
assert.match(source, /xDomain = xValues;/);
assert.match(source, /tickSpacing: 80/);
assert.match(source, /transform=\{\{ mode: "domain", axis: "x" \}\}/);
assert.match(source, /tooltipContext=\{\{ mode: "band" \}\}/);
assert.match(source, /\.sparkline :global\(\.lc-layout-svg\)\s*\{[^}]*overflow:\s*hidden;/);
