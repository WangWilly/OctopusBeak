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
  assert.equal(await api.dataViews.enabled(), true);
  assert.equal(typeof api.dataViews.subscribe, "function");
  assert.equal(typeof api.automation.loadBlock, "function");
  assert.deepEqual(await api.data.getVersion(), {
    version: 0,
    stale: false,
    changedAt: null,
  });
});

test("shared browser runtime isolates scenarios and survives client failure across processes", async (t) => {
  const { startBrowserTestRuntime } = await import("./browser-test-runtime.mjs");
  const { spawn } = await import("node:child_process");
  const owner = await startBrowserTestRuntime();
  t.after(() => owner.close());
  const runtimeUrl = new URL("./browser-test-runtime.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { acquireBrowserTestRuntime } from ${JSON.stringify(runtimeUrl)};
    const runtime = await acquireBrowserTestRuntime();
    try {
      for (let scenario = 0; scenario < 2; scenario++) {
        const cleanup = [];
        const page = await runtime.newPage({ after: (fn) => cleanup.push(fn) });
        try {
          await page.route("**/isolation-fixture", (route) => route.fulfill({ body: "fixture", contentType: "text/html" }));
          await page.goto(runtime.url + "isolation-fixture");
          assert.equal(await page.evaluate(() => localStorage.getItem("fixture")), null);
          assert.deepEqual(await page.context().cookies(), []);
          await page.evaluate(() => {
            localStorage.setItem("fixture", "private");
            document.cookie = "fixture=private";
            window.fixture = "private";
          });
          if (scenario === 0) throw new Error("synthetic scenario failure");
        } catch (error) {
          if (error.message !== "synthetic scenario failure") throw error;
        } finally {
          for (const close of cleanup) await close();
        }
        assert.equal(page.isClosed(), true);
      }
      if (process.env.FAIL_RUNTIME_CLIENT) throw new Error("synthetic file failure");
    } finally {
      await runtime.close();
    }
  `;
  const runClient = (fail) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...owner.env, FAIL_RUNTIME_CLIENT: fail ? "1" : "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
  const failed = await runClient(true);
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /synthetic file failure/u);
  const next = await runClient(false);
  assert.equal(next.code, 0, next.output);
});
