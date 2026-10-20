import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_CHECK_FILES,
  ELECTRON_CDP_FILES,
  HARD_PERFORMANCE_FILES,
  combineCiReports,
  discoverBrowserTestFiles,
  discoverElectronCdpTestFiles,
  discoverPerformanceTestFiles,
  discoverUnitTestFiles,
  parseShard,
} from "./run-test-lane.mjs";

test("test lanes include each browser check exactly once and exclude hard performance checks", () => {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  const browser = discoverBrowserTestFiles();
  const electronCdp = discoverElectronCdpTestFiles();
  const unit = discoverUnitTestFiles();
  const performance = discoverPerformanceTestFiles();
  const all = [...unit, ...electronCdp, ...browser];

  assert.match(packageJson.scripts.test, /run-test-lane\.mjs all/u);
  assert.match(packageJson.scripts["test:ci"], /run-test-lane\.mjs ci/u);
  assert.equal(packageJson.scripts.pretest, "npm run build");
  assert.equal(packageJson.scripts["pretest:ci"], "npm run build");
  assert.deepEqual(browser, [...BROWSER_CHECK_FILES].sort());
  assert.deepEqual(electronCdp, [...ELECTRON_CDP_FILES].sort());
  assert.deepEqual(performance, [...HARD_PERFORMANCE_FILES].sort());
  for (const file of BROWSER_CHECK_FILES) {
    assert.equal(all.filter((candidate) => candidate === file).length, 1, `${file} must be scheduled once`);
  }
  for (const file of HARD_PERFORMANCE_FILES) {
    assert.equal(all.includes(file), false, `${file} must remain outside ordinary test lanes`);
    assert.equal(performance.filter((candidate) => candidate === file).length, 1, `${file} must be scheduled once`);
  }
  for (const file of ELECTRON_CDP_FILES) {
    assert.equal(unit.includes(file), false, `${file} must remain outside the concurrent unit lane`);
    assert.equal(electronCdp.filter((candidate) => candidate === file).length, 1, `${file} must be scheduled once`);
  }
  assert.equal(new Set(all).size, all.length, "a test file must not be scheduled twice");
  assert.ok(unit.some((file) => file.startsWith("src/")), "unit lane should retain TypeScript checks");
});

test("a CI shard names one slice of the unit lane or is rejected", () => {
  assert.equal(parseShard(["unit"]), null);
  assert.deepEqual(parseShard(["unit", "--shard=2/4"]), { index: 2, total: 4 });
  for (const value of ["0/4", "5/4", "2", "a/b"]) {
    assert.throws(() => parseShard([`--shard=${value}`]), /Invalid shard/u);
  }
});

test("combined CI reports keep lane order, order shards numerically, and stitch every test case", () => {
  const reports = mkdtempSync(join(tmpdir(), "combine-ci-reports-"));
  try {
    for (const prefix of ["performance", "unit-10-of-12", "browser", "unit-2-of-12", "electron-cdp"]) {
      writeFileSync(join(reports, `test-summary-${prefix}.txt`), `${prefix} summary\n`);
      writeFileSync(
        join(reports, `junit-${prefix}.xml`),
        `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n\t<testcase name="${prefix}"/>\n</testsuites>\n`,
      );
    }
    combineCiReports(reports);

    const summary = readFileSync(join(reports, "test-summary.txt"), "utf8");
    assert.deepEqual(
      [...summary.matchAll(/^# (.+) lane$/gmu)].map((match) => match[1]),
      ["unit-2-of-12", "unit-10-of-12", "electron-cdp", "browser", "performance"],
    );
    assert.match(summary, /# browser lane\nbrowser summary\n/u);
    const junit = readFileSync(join(reports, "junit.xml"), "utf8");
    assert.match(junit, /^<testsuites>[\s\S]*<\/testsuites>\n$/u);
    assert.equal(junit.match(/<testsuites>/gu)?.length, 1, "the merged report has one root");
    assert.deepEqual(
      [...junit.matchAll(/<testcase name="([^"]+)"/gu)].map((match) => match[1]),
      ["unit-2-of-12", "unit-10-of-12", "electron-cdp", "browser", "performance"],
    );
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
});
