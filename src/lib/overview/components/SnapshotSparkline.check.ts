import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SnapshotSparkline.svelte", import.meta.url), "utf8");

assert.match(source, /x="position"/);
assert.match(source, /tickSpacing: 80/);
