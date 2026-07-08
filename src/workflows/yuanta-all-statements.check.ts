import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./yuanta-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /for \(const scope of \[\.\.\.page\.frames\(\), page\]\)/);
assert.match(source, /const hasMonthLink = await hasAttachedLocator\(/);
assert.match(source, /const hasTable = await hasAttachedLocator\(/);
assert.match(source, /if \(hasMonthLink && hasTable\) return true/);
assert.match(source, /yuanta-all-component-start[\s\S]*startedAt/);
assert.match(source, /yuanta-all-component-complete[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-failed[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-page-ready[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-page-not-ready[\s\S]*durationMs/);
assert.doesNotMatch(
  source,
  /\.or\(candidate\.locator\('a\[onclick\*="queryMonth\("\]'\)\)/,
);
