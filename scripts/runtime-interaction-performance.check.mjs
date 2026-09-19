import assert from "node:assert/strict";
import { readFileSync as readPackageFile } from "node:fs";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./check-pairing-ui-performance.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readPackageFile(new URL("../package.json", import.meta.url), "utf8"));

test("cold Pairing starts from an interactive purchase view instead of waiting for prewarm", () => {
  const prewarmWait = source.indexOf("waitForFunction(() => window.__pairingPrewarmDone");
  const pairingClick = source.indexOf('locator("[data-open-pairing]").first().click()');
  assert.ok(pairingClick >= 0, "the isolated Pairing benchmark must click the real Pairing control");
  assert.equal(prewarmWait, -1, "cold Pairing must not wait for prewarm before the click");
});

test("runtime interaction performance is an explicit isolated command", () => {
  assert.match(
    packageJson.scripts["check:runtime-interaction-performance"],
    /check-runtime-interaction-performance\.mjs/u,
  );
  assert.match(packageJson.scripts.test, /run-test-lane\.mjs all/u);
  assert.doesNotMatch(packageJson.scripts.test, /check-runtime-interaction-performance\.mjs/u);
});
