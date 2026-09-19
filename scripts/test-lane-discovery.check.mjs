import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_CHECK_FILES,
  HARD_PERFORMANCE_FILES,
  discoverBrowserTestFiles,
  discoverUnitTestFiles,
} from "./run-test-lane.mjs";

test("test lanes include each browser check exactly once and exclude hard performance checks", () => {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  const browser = discoverBrowserTestFiles();
  const unit = discoverUnitTestFiles();
  const all = [...unit, ...browser];

  assert.match(packageJson.scripts.test, /run-test-lane\.mjs all/u);
  assert.match(packageJson.scripts["test:ci"], /run-test-lane\.mjs ci/u);
  assert.deepEqual(browser, [...BROWSER_CHECK_FILES].sort());
  for (const file of BROWSER_CHECK_FILES) {
    assert.equal(all.filter((candidate) => candidate === file).length, 1, `${file} must be scheduled once`);
  }
  for (const file of HARD_PERFORMANCE_FILES) {
    assert.equal(all.includes(file), false, `${file} must remain outside ordinary test lanes`);
  }
  assert.equal(new Set(all).size, all.length, "a test file must not be scheduled twice");
  assert.ok(unit.some((file) => file.startsWith("src/")), "unit lane should retain TypeScript checks");
});
