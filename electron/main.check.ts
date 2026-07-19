import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.match(
  source,
  /try\s*{\s*prepareLibrettoRunCdpPatch\(\);\s*}\s*catch\s*\(error\)\s*{\s*console\.warn\("libretto-run-cdp-patch-failed", error\);\s*}/,
);
