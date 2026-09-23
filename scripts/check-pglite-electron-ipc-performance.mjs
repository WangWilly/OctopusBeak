import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, platform, release, totalmem, version as osVersion, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPGlitePairingPerformanceFixture } from "../src/ledger/pglite/spending-performance-fixture.ts";

const require = createRequire(import.meta.url);
const electron = require("electron");
const electronVersion = JSON.parse(await readFile(new URL("../node_modules/electron/package.json", import.meta.url))).version;
const main = fileURLToPath(new URL("../build-electron/main.cjs", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForCdp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch { /* Electron is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP endpoint did not start");
}

async function arm(page, action, conditions) {
  await page.evaluate(({ action, conditions }) => {
    const samples = { click: null, states: {} };
    window.__pgliteElectronPerf = samples;
    const target = document.querySelector(action);
    if (!target) throw new Error(`Missing action ${action}`);
    const inspect = () => {
      for (const [name, selector] of Object.entries(conditions)) {
        if (name === "complete" && samples.states.feedback === undefined) continue;
        if (samples.states[name] === undefined && document.querySelector(selector))
          samples.states[name] = performance.now();
      }
    };
    target.addEventListener("click", () => {
      samples.click = performance.now();
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
      inspect();
      window.__pgliteElectronPerfObserver?.disconnect();
      window.__pgliteElectronPerfObserver = observer;
    }, { capture: true, once: true });
  }, { action, conditions });
}

async function sample(page, name, timeout = 30_000) {
  await page.waitForFunction((key) => window.__pgliteElectronPerf?.states[key] !== undefined, name, { timeout });
  return page.evaluate((key) => window.__pgliteElectronPerf.states[key] - window.__pgliteElectronPerf.click, name);
}

const temp = await mkdtemp(join(tmpdir(), "octopus-pglite-electron-ipc-perf-"));
const userData = join(temp, "user-data");
let fixture;
let child;
let browser;
let output = "";
let failure;
try {
  await mkdir(join(userData, "data"), { recursive: true });
  fixture = await createPGlitePairingPerformanceFixture({ dataDir: join(userData, "data", "pglite") });
  assert.deepEqual(fixture.counts, {
    transactions: 100_000,
    invoices: 10_001,
    activeLinks: 10_000,
    dateFacts: 100_000,
  });
  await fixture.store.close();
  const port = await freePort();
  const started = performance.now();
  child = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main], {
    cwd: temp,
    env: {
      ...process.env,
      OCTOPUSBEAK_USER_DATA: userData,
      OCTOPUSBEAK_CDP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  await waitForCdp(url);
  browser = await chromium.connectOverCDP(url);
  const page = browser.contexts()[0]?.pages()[0];
  assert.ok(page, "Electron renderer must be available");
  await page.waitForFunction(() => window.location.hash === "#/overview", undefined, { timeout: 30_000 });
  const shellStartupMs = performance.now() - started;
  assert.equal(await page.evaluate(() => window.octopusBeak.dataViews.enabled()), true);
  await page.evaluate(() => localStorage.setItem("octopusbeak-welcome-v1", JSON.stringify({
    version: 1, status: "bypassed", currentSlide: 1, bankAutomationChoice: null,
  })));
  await page.reload();
  await page.locator("[data-overview-state]").first().waitFor({ state: "visible", timeout: 60_000 });
  const overviewReadyMs = performance.now() - started;
  await page.evaluate(() => {
    window.__pgliteElectronLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__pgliteElectronLongTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });

  await arm(page, '[data-onboarding="nav-spending"]', {
    feedback: '[data-onboarding="nav-spending"].active',
    complete: '[data-chart], .purchase-summary-card',
  });
  await page.locator('[data-onboarding="nav-spending"]').click();
  const navigationFeedbackMs = await sample(page, "feedback");
  const navigationMs = await sample(page, "complete", 60_000);
  await page.locator('.month-picker select').selectOption("2026-01");
  await page.locator('.chart-period-picker select').selectOption("2026-01-01");
  await page.locator('[data-purchase-day="2026-01-01"] [data-open-pairing]').first().waitFor({ timeout: 60_000 });

  await arm(page, '[data-purchase-day="2026-01-01"] [data-open-pairing]', {
    feedback: '[data-pairing-dialog][data-pairing-feedback="open-dialog"]',
    complete: `[data-pairing-dialog] input[name="spending-payment"][value="${fixture.targetTransactionId}"]`,
  });
  await page.locator('[data-purchase-day="2026-01-01"] [data-open-pairing]').first().click();
  const openFeedbackMs = await sample(page, "feedback");
  const openMs = await sample(page, "complete", 60_000);
  const totalCandidateCount = Number(await page.locator("[data-total-candidate-count]").getAttribute("data-total-candidate-count"));
  assert.equal(totalCandidateCount, 90_000);
  await page.locator(`[data-pairing-dialog] input[value="${fixture.targetTransactionId}"]`).check();

  await arm(page, '[data-confirm-direct-pair]', {
    feedback: '[data-pairing-feedback="confirm-busy"]',
    complete: `[data-purchase-record][data-basis="linked"][data-transaction-id="${fixture.targetTransactionId}"]`,
  });
  await page.locator('[data-confirm-direct-pair]').click();
  const confirmFeedbackMs = await sample(page, "feedback");
  const confirmMs = await sample(page, "complete", 60_000);
  assert.equal(await page.locator("[data-pairing-dialog]").count(), 0);

  const revokeSelector = `[data-purchase-record][data-transaction-id="${fixture.targetTransactionId}"] [data-revoke-link]`;
  await arm(page, revokeSelector, {
    feedback: `${revokeSelector}:disabled`,
    complete: '[data-purchase-day="2026-01-01"] [data-open-pairing]',
  });
  await page.locator(revokeSelector).click();
  const revokeFeedbackMs = await sample(page, "feedback");
  const revokeMs = await sample(page, "complete", 60_000);
  await arm(page, '[data-purchase-day="2026-01-01"] [data-open-pairing]', {
    feedback: '[data-pairing-dialog][data-pairing-feedback="open-dialog"]',
    complete: `[data-pairing-dialog] input[name="spending-payment"][value="${fixture.targetTransactionId}"]`,
  });
  await page.locator('[data-purchase-day="2026-01-01"] [data-open-pairing]').first().click();
  const reopenAfterRevokeFeedbackMs = await sample(page, "feedback");
  const reopenAfterRevokeMs = await sample(page, "complete", 60_000);
  await page.locator(`[data-pairing-dialog] input[value="${fixture.targetTransactionId}"]`).check();
  await arm(page, '[data-confirm-direct-pair]', {
    feedback: '[data-pairing-feedback="confirm-busy"]',
    complete: `[data-purchase-record][data-basis="linked"][data-transaction-id="${fixture.targetTransactionId}"]`,
  });
  await page.locator('[data-confirm-direct-pair]').click();
  const warmConfirmFeedbackMs = await sample(page, "feedback");
  const warmConfirmMs = await sample(page, "complete", 60_000);
  assert.equal(await page.locator("[data-pairing-dialog]").count(), 0);

  await arm(page, ".refresh-trigger", {
    feedback: '.refresh-trigger[data-refresh-state="refreshing"]',
    complete: '.refresh-trigger[data-refresh-state="current"]',
  });
  await page.locator(".refresh-trigger").click();
  const refreshFeedbackMs = await sample(page, "feedback");
  const refreshMs = await sample(page, "complete", 60_000);
  const longTasks = await page.evaluate(() => window.__pgliteElectronLongTasks);
  const evidence = {
    transport: "Electron renderer -> preload -> ipcMain -> PGlite worker",
    platform: platform(), osVersion: osVersion(), kernel: release(),
    machine: cpus()[0]?.model, ramBytes: totalmem(), node: process.version, electron: electronVersion,
    fixture: fixture.counts, shellStartupMs, overviewReadyMs,
    navigationFeedbackMs, navigationMs, refreshFeedbackMs, refreshMs,
    openFeedbackMs, openMs, confirmFeedbackMs, confirmMs,
    revokeFeedbackMs, revokeMs, reopenAfterRevokeFeedbackMs, reopenAfterRevokeMs,
    warmConfirmFeedbackMs, warmConfirmMs,
    totalCandidateCount, maxRendererLongTaskMs: Math.max(0, ...longTasks),
  };
  console.log(JSON.stringify(evidence, null, 2));
  assert.ok(navigationFeedbackMs <= 200 && refreshFeedbackMs <= 200 && openFeedbackMs <= 200 && confirmFeedbackMs <= 200
    && revokeFeedbackMs <= 200 && reopenAfterRevokeFeedbackMs <= 200 && warmConfirmFeedbackMs <= 200,
    "Electron interaction feedback exceeded 200 ms");
  assert.ok(openMs <= 1_000 && confirmMs <= 1_000 && reopenAfterRevokeMs <= 1_000 && warmConfirmMs <= 1_000,
    "Electron IPC Pairing exceeded one second");
} catch (error) {
  console.error(output.slice(-3_000));
  failure = error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (browser) await Promise.race([
    browser.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child && child.exitCode === null && child.signalCode === null) await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
// Playwright's attached CDP transport can retain a handle after Electron
// exits. The benchmark has already closed its browser and removed the fixture.
process.exit(0);
