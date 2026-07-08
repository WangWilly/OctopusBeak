import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./yuanta-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /if \(page\.frame\(\{ name: "fmain" \}\) && currentCidFromFrameUrls\(page\)\) return;/,
);
