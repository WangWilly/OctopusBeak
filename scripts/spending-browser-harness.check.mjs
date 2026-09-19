import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpendingDesktopApi,
  createSpendingViteServer,
} from "./spending-browser-harness.mjs";

test("parallel spending checks receive distinct strict Vite ports", async () => {
  const [first, second] = await Promise.all([
    createSpendingViteServer(),
    createSpendingViteServer(),
  ]);
  try {
    const firstPort = first.httpServer?.address()?.port;
    const secondPort = second.httpServer?.address()?.port;
    assert.equal(typeof firstPort, "number");
    assert.equal(typeof secondPort, "number");
    assert.notEqual(firstPort, secondPort);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("spending browser fixture exposes the renderer data and block contracts", async () => {
  const api = createSpendingDesktopApi({ canonical: "fixture" });
  assert.equal(typeof api.data.getVersion, "function");
  assert.equal(typeof api.data.acknowledgeVersion, "function");
  assert.equal(typeof api.data.onInvalidated, "function");
  assert.equal(typeof api.overview.loadBlock, "function");
  assert.equal(typeof api.assets.loadBlock, "function");
  assert.equal(typeof api.liabilities.loadBlock, "function");
  assert.equal(typeof api.spending.loadBlock, "function");
  assert.equal(typeof api.spending.prewarmPairingCandidates, "function");
  assert.equal(typeof api.automation.loadBlock, "function");
  assert.deepEqual(await api.data.getVersion(), {
    version: 0,
    stale: false,
    changedAt: null,
  });
});
