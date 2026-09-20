import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./check-pairing-ui-performance.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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

test("runtime scenarios prove browser, worker, server, and fixture disposal", () => {
  const runtimeSource = readFileSync(new URL("./check-runtime-interaction-performance.mjs", import.meta.url), "utf8");
  assert.match(runtimeSource, /page\?\.close\(\)/u);
  assert.match(runtimeSource, /browser\?\.isConnected\(\)/u);
  assert.match(runtimeSource, /worker\.terminate\(\)/u);
  assert.match(runtimeSource, /server\?\.httpServer\?\.listening/u);
  assert.match(runtimeSource, /existsSync\(fixture\.directory\)/u);
});

test("pairing fixture payload is released before timed interaction", () => {
  const runtimeSource = readFileSync(new URL("./check-runtime-interaction-performance.mjs", import.meta.url), "utf8");
  assert.match(packageJson.scripts["check:runtime-interaction-performance"], /--expose-gc/u);
  assert.match(runtimeSource, /model = null/u);
  assert.match(runtimeSource, /globalThis\.gc\(\)/u);
});

test("Pairing SLA uses in-page actionable DOM timestamps while retaining browser assertions", () => {
  const runtimeSource = readFileSync(new URL("./check-runtime-interaction-performance.mjs", import.meta.url), "utf8");
  assert.match(runtimeSource, /__pairingCandidateRenderedAt/u);
  assert.match(runtimeSource, /__pairingConfirmRenderedAt/u);
  assert.match(runtimeSource, /__runtimeFinishAt\(\s*"pairing-open"/u);
  assert.match(runtimeSource, /__runtimeFinishAt\(\s*"pairing-confirm"/u);
  assert.match(runtimeSource, /input\[value=/u);
  assert.match(runtimeSource, /data-basis="linked"/u);
});
