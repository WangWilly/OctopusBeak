import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const testCommand = String(packageJson.scripts.test);

assert.equal(typeof packageJson.scripts["check:pairing-ui-performance"], "string");
assert.match(packageJson.scripts["check:pairing-ui-performance"], /check-pairing-ui-performance\.mjs/u);
assert.doesNotMatch(testCommand, /spending-ui-pairing\.check\.mjs/u);
assert.match(testCommand, /run-test-lane\.mjs all/u);
assert.equal(
  fileURLToPath(new URL("./check-pairing-ui-performance.mjs", import.meta.url)).endsWith(
    "check-pairing-ui-performance.mjs",
  ),
  true,
);
