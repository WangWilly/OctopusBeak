import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /yuanta-fund-positions-found/);
assert.match(source, /yuanta-fund-history-start/);
assert.match(source, /yuanta-fund-positions-found[\s\S]*durationMs/);
assert.match(source, /yuanta-fund-history-start[\s\S]*startedAt/);
assert.match(source, /yuanta-fund-history-complete[\s\S]*durationMs/);
assert.match(source, /const fundProgress = \(\) =>/);
assert.match(source, /automation-progress: \$\{[\s\S]*75 \+[\s\S]*Math\.min\(\s*24,/);
