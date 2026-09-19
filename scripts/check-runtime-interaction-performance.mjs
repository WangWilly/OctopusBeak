import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { chromium } from "playwright";
import { createFinancialPageWorkerClient } from "../electron/financial-page-worker-client.ts";
import { createPairingBenchmarkFixture } from "./check-pairing-performance.ts";
import { makeRendererModel } from "./check-pairing-ui-performance.mjs";
import {
  createSpendingViteServer,
  spendingDesktopApiInitScript,
} from "./spending-browser-harness.mjs";

const FEEDBACK_MS = 200;
const PAIRING_SLA_MS = 1_000;
const DELAY_MS = 700;
const EXPECTED_FIXTURE_SHAPE = {
  transactions: 100_000,
  invoices: 10_000,
  linksBefore: 9_999,
  linksAfter: 10_000,
  rendererRecords: 100_000,
  rendererInvoiceIdentities: 10_000,
};
const electronPackage = JSON.parse(
  readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
);

function rendererInstrumentation() {
  window.__runtimeRenderer = {
    longTasks: [],
    rafGaps: [],
    windows: {},
    longTaskObserverAvailable: "PerformanceObserver" in window,
  };
  let previousRafAt = performance.now();
  const observeRaf = (now) => {
    window.__runtimeRenderer.rafGaps.push({
      end: now,
      gap: now - previousRafAt,
      start: previousRafAt,
    });
    previousRafAt = now;
    requestAnimationFrame(observeRaf);
  };
  requestAnimationFrame(observeRaf);
  if ("PerformanceObserver" in window) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__runtimeRenderer.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  }
  window.__runtimeStart = (kind) => {
    const start = performance.now();
    window.__runtimeRenderer.windows[kind] = { start, end: null };
    performance.mark(`runtime-${kind}-start`);
    return start;
  };
  window.__runtimeFinish = (kind) => {
    const end = performance.now();
    const windowValue = window.__runtimeRenderer.windows[kind];
    if (!windowValue) throw new Error(`Runtime interaction ${kind} was not started.`);
    windowValue.end = end;
    performance.mark(`runtime-${kind}-end`);
    performance.measure(`runtime-${kind}`, {
      start: `runtime-${kind}-start`,
      end: `runtime-${kind}-end`,
    });
    return performance.getEntriesByName(`runtime-${kind}`).at(-1).duration;
  };
  const startShellStartup = () => {
    if (!window.__runtimeRenderer.windows["shell-startup"])
      window.__runtimeStart("shell-startup");
  };
  document.addEventListener("DOMContentLoaded", startShellStartup, { once: true });
  if (document.readyState !== "loading") queueMicrotask(startShellStartup);
  window.__runtimeRendererEvidence = async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const windows = Object.values(window.__runtimeRenderer.windows);
    const overlaps = (entry, windowValue) =>
      windowValue.end !== null
      && entry.start < windowValue.end
      && entry.start + entry.duration > windowValue.start;
    const measures = Object.fromEntries(Object.keys(window.__runtimeRenderer.windows).map((kind) => {
      const entry = performance.getEntriesByName(`runtime-${kind}`).at(-1);
      return [kind, entry ? { start: entry.startTime, duration: entry.duration } : null];
    }));
    const longTasks = window.__runtimeRenderer.longTasks.filter((entry) =>
      windows.some((windowValue) => overlaps(entry, windowValue)));
    const rafGaps = window.__runtimeRenderer.rafGaps.filter((entry) =>
      windows.some((windowValue) => windowValue.end !== null
        && entry.end > windowValue.start
        && entry.start < windowValue.end));
    return {
      measures,
      longTasks,
      longTaskObserverAvailable: window.__runtimeRenderer.longTaskObserverAvailable,
      maxRafGapMs: Math.max(0, ...rafGaps.map((entry) => entry.gap)),
    };
  };
}

function installDelayedRouteApis(delayMs) {
  window.__runtimeApi = { pending: 0, started: [] };
  const delayed = (callback, label) => (...args) => {
    window.__runtimeApi.pending += 1;
    window.__runtimeApi.started.push(label);
    return new Promise((resolve, reject) => {
      window.setTimeout(async () => {
        try {
          resolve(await callback(...args));
        } catch (error) {
          reject(error);
        } finally {
          window.__runtimeApi.pending -= 1;
        }
      }, delayMs);
    });
  };
  for (const key of ["overview", "assets", "liabilities", "spending", "automation"]) {
    const routeApi = window.octopusBeak[key];
    routeApi.load = delayed(routeApi.load, `${key}.load`);
    routeApi.loadBlock = delayed(routeApi.loadBlock, `${key}.loadBlock`);
  }
  window.octopusBeak.data.acknowledgeVersion = delayed(
    window.octopusBeak.data.acknowledgeVersion,
    "data.acknowledgeVersion",
  );
}

function installPairingBridge() {
  window.__pairingPrewarmVersions = [];
  window.__pairingPrewarmStarted = false;
  window.__pairingPrewarmDone = false;
  window.octopusBeak.spending.rankPairingCandidates = (input) => window.__pairingRankThroughWorker(input);
  window.octopusBeak.spending.confirmCandidate = (input) => window.__pairingConfirmThroughWorker(input);
  window.octopusBeak.spending.prewarmPairingCandidates = async (input) => {
    window.__pairingPrewarmStarted = true;
    const result = await window.__pairingPrewarmThroughWorker(input);
    window.__pairingPrewarmVersions.push(result.dataVersion);
    window.__pairingPrewarmDone = true;
    return result;
  };
}

function assertRendererResponsiveness(evidence, label) {
  const longTaskFailures = evidence.longTasks.filter((entry) => entry.duration > FEEDBACK_MS);
  assert.deepEqual(longTaskFailures, [], `${label} renderer long task exceeded ${FEEDBACK_MS}ms`);
  assert.ok(evidence.maxRafGapMs <= FEEDBACK_MS, `${label} renderer rAF gap exceeded ${FEEDBACK_MS}ms`);
}

async function startWorker() {
  const worker = new Worker(new URL("../electron/financial-page-worker.ts", import.meta.url), { type: "module" });
  await new Promise((resolve, reject) => {
    worker.once("message", (message) => message.id === 0 ? resolve() : reject(new Error("Financial worker readiness handshake failed.")));
    worker.once("error", reject);
  });
  return { worker, client: createFinancialPageWorkerClient(worker) };
}

async function runShellRuntimeAcceptance() {
  const server = await createSpendingViteServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript({ content: spendingDesktopApiInitScript({ canonical: { availability: "empty" } }) });
    await page.addInitScript(rendererInstrumentation);
    await page.addInitScript({ content: `(${installDelayedRouteApis.toString()})(${DELAY_MS})` });
    await page.addInitScript(() => {
      localStorage.setItem("octopusbeak-locale", "en");
      localStorage.setItem("octopusbeak-welcome-v1", JSON.stringify({
        version: 1,
        status: "bypassed",
        currentSlide: 1,
        bankAutomationChoice: null,
      }));
    });
    await page.goto(`http://127.0.0.1:${address.port}/#/overview`);
    await page.locator(".topbar").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => window.__runtimeApi.pending === 0, undefined, { timeout: 30_000 });
    await page.reload();
    await page.locator(".topbar").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator('[data-onboarding="nav-overview"]').waitFor({ state: "visible" });
    const shellStartupMs = await page.evaluate(() => window.__runtimeFinish("shell-startup"));
    assert.ok(shellStartupMs <= FEEDBACK_MS, `shell startup feedback exceeded ${FEEDBACK_MS}ms: ${shellStartupMs}`);
    assert.ok(await page.evaluate(() => window.__runtimeApi.pending > 0), "shell must remain visible while route data is pending");

    await page.evaluate(() => window.__runtimeStart("navigation"));
    await page.locator('[data-onboarding="nav-assets"]').click();
    await page.locator('a[data-onboarding="nav-assets"].active').waitFor({ state: "visible" });
    const navigationMs = await page.evaluate(() => window.__runtimeFinish("navigation"));
    assert.ok(navigationMs <= FEEDBACK_MS, `navigation feedback exceeded ${FEEDBACK_MS}ms: ${navigationMs}`);
    assert.ok(await page.evaluate(() => window.__runtimeApi.pending > 0), "navigation must leave delayed route data pending");

    await page.evaluate(() => window.__runtimeStart("refresh-feedback"));
    await page.locator(".refresh-trigger").click();
    await page.locator('[data-refresh-state="refreshing"]').waitFor({ state: "visible" });
    const refreshFeedbackMs = await page.evaluate(() => window.__runtimeFinish("refresh-feedback"));
    assert.ok(refreshFeedbackMs <= FEEDBACK_MS, `refresh feedback exceeded ${FEEDBACK_MS}ms: ${refreshFeedbackMs}`);
    const refreshAttributes = await page.locator(".refresh-trigger").evaluate((element) => ({
      ariaBusy: element.getAttribute("aria-busy"),
      disabled: element.hasAttribute("disabled"),
    }));
    assert.deepEqual(refreshAttributes, { ariaBusy: "true", disabled: true });
    const sidebarBefore = await page.locator(".sidebar-toggle").getAttribute("aria-expanded");
    await page.locator(".sidebar-toggle").click();
    await page.waitForFunction((before) => document.querySelector(".sidebar-toggle")?.getAttribute("aria-expanded") !== before, sidebarBefore);
    assert.ok(await page.evaluate(() => window.__runtimeApi.pending > 0), "refresh must remain pending after another UI click");

    const rendererEvidence = await page.evaluate(() => window.__runtimeRendererEvidence());
    assertRendererResponsiveness(rendererEvidence, "shell/navigation/refresh");
    assert.deepEqual(errors, []);
    return {
      shellStartupMs,
      navigationMs,
      refreshFeedbackMs,
      rendererEvidence,
      delayedApiCalls: await page.evaluate(() => ({
        pending: window.__runtimeApi.pending,
        started: window.__runtimeApi.started,
      })),
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

async function runColdPairing(runNumber) {
  const startedAt = performance.now();
  const fixture = await createPairingBenchmarkFixture();
  let preflight;
  let actual;
  let server;
  let browser;
  try {
    process.env.LEDGER_DIR = fixture.directory;
    preflight = await startWorker();
    const ranked = await preflight.client.rankPairingCandidates({
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion: fixture.dataVersion,
      limit: 50,
    });
    const selectedCandidate = ranked.candidates[0];
    assert.ok(selectedCandidate, "100k fixture must expose a Pairing candidate");
    assert.equal(ranked.totalCandidateCount, EXPECTED_FIXTURE_SHAPE.transactions - EXPECTED_FIXTURE_SHAPE.linksBefore);
    await preflight.client.close();
    preflight = null;

    const model = makeRendererModel(fixture.targetInvoiceId, selectedCandidate);
    model.purchaseReport.knowledgeAt = fixture.dataVersion;
    const invoiceIds = new Set(model.purchaseReport.records.flatMap((record) =>
      record.invoice ? [record.invoice.invoiceId] : []));
    assert.equal(model.purchaseReport.records.length, EXPECTED_FIXTURE_SHAPE.rendererRecords);
    assert.equal(invoiceIds.size, EXPECTED_FIXTURE_SHAPE.rendererInvoiceIdentities);
    server = await createSpendingViteServer();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ headless: true });
    actual = await startWorker();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const bridgeTimings = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__pairingRankThroughWorker", async (input) => {
      const bridgeStartedAt = performance.now();
      try {
        return await actual.client.rankPairingCandidates(input);
      } finally {
        bridgeTimings.push({ kind: "rank", elapsedMs: performance.now() - bridgeStartedAt });
      }
    });
    await page.exposeFunction("__pairingConfirmThroughWorker", async (input) => {
      const bridgeStartedAt = performance.now();
      try {
        return await actual.client.confirmCandidate({
          ...input,
          pairingReportContext: {
            recordInsertIndex: 0,
            candidateIds: [],
            totalStatusAfter: "complete",
          },
        });
      } finally {
        bridgeTimings.push({ kind: "confirm", elapsedMs: performance.now() - bridgeStartedAt });
      }
    });
    await page.exposeFunction("__pairingPrewarmThroughWorker", async (input) => {
      const bridgeStartedAt = performance.now();
      try {
        return await actual.client.prewarmPairingCandidates(input);
      } finally {
        bridgeTimings.push({ kind: "prewarm", elapsedMs: performance.now() - bridgeStartedAt });
      }
    });
    await page.addInitScript({ content: spendingDesktopApiInitScript(model) });
    await page.addInitScript(rendererInstrumentation);
    await page.addInitScript(installPairingBridge);
    await page.addInitScript(() => {
      localStorage.setItem("octopusbeak-locale", "en");
    });
    await page.goto(`http://127.0.0.1:${address.port}/#/spending`);
    await page.locator("[data-purchase-report]").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => window.__pairingPrewarmStarted === true, undefined, { timeout: 30_000 });
    const prewarmDoneAtClick = await page.evaluate(() => window.__pairingPrewarmDone);
    assert.equal(prewarmDoneAtClick, false, "cold Pairing click must happen before prewarm resolves");

    await page.evaluate(() => {
      window.__runtimeStart("pairing-open-feedback");
      window.__runtimeStart("pairing-open");
    });
    await page.locator("[data-open-pairing]").first().click();
    await page.locator('[data-pairing-dialog][data-pairing-feedback="open-dialog"]').waitFor({ state: "visible", timeout: 30_000 });
    const openFeedbackMs = await page.evaluate(() => window.__runtimeFinish("pairing-open-feedback"));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const openMs = await page.evaluate(() => window.__runtimeFinish("pairing-open"));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).check();

    await page.evaluate(() => {
      window.__runtimeStart("pairing-confirm-feedback");
      window.__runtimeStart("pairing-confirm");
    });
    await page.locator("[data-confirm-direct-pair]").click();
    await page.locator('[data-pairing-dialog] [data-pairing-feedback="confirm-busy"]').waitFor({ state: "visible", timeout: 30_000 });
    const confirmFeedbackMs = await page.evaluate(() => window.__runtimeFinish("pairing-confirm-feedback"));
    await page.locator("[data-pairing-dialog]").waitFor({ state: "detached", timeout: 30_000 });
    await page.locator(`[data-purchase-record][data-basis="linked"][data-transaction-id="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const confirmMs = await page.evaluate(() => window.__runtimeFinish("pairing-confirm"));
    const rendererEvidence = await page.evaluate(() => window.__runtimeRendererEvidence());
    assert.ok(openFeedbackMs <= FEEDBACK_MS, `Pairing open feedback exceeded ${FEEDBACK_MS}ms: ${openFeedbackMs}`);
    assert.ok(confirmFeedbackMs <= FEEDBACK_MS, `Pairing confirm feedback exceeded ${FEEDBACK_MS}ms: ${confirmFeedbackMs}`);
    assert.ok(openMs <= PAIRING_SLA_MS, `Pairing open exceeded ${PAIRING_SLA_MS}ms: ${openMs}`);
    assert.ok(confirmMs <= PAIRING_SLA_MS, `Pairing confirm exceeded ${PAIRING_SLA_MS}ms: ${confirmMs}`);
    assertRendererResponsiveness(rendererEvidence, `Pairing run ${runNumber}`);
    const verificationDb = new DatabaseSync(join(fixture.directory, "canonical.sqlite"), { readOnly: true });
    const persistedLink = verificationDb.prepare(`
      SELECT COUNT(*) AS count
      FROM current_spending_dedup_links
      WHERE invoice_id = ? AND transaction_id = ?
    `).get(
      Buffer.from(fixture.targetInvoiceId.replaceAll("-", ""), "hex"),
      Buffer.from(selectedCandidate.transactionId.replaceAll("-", ""), "hex"),
    );
    verificationDb.close();
    assert.equal(persistedLink.count, 1);
    assert.deepEqual(errors, []);
    const evidence = {
      runNumber,
      setupMs: fixture.setupMs,
      totalMs: performance.now() - startedAt,
      rendererModelRecordCount: model.purchaseReport.records.length,
      rendererModelInvoiceIdentityCount: invoiceIds.size,
      initialRenderedRecordCount: await page.locator("[data-purchase-record]").count(),
      prewarmDoneAtClick,
      openFeedbackMs,
      openMs,
      confirmFeedbackMs,
      confirmMs,
      rendererEvidence,
      bridgeTimings,
      machine: `${process.arch}/${platform()}`,
      machineModel: cpus()[0]?.model ?? "unknown",
      memoryBytes: totalmem(),
      macOSVersion: osVersion(),
      macOSRelease: release(),
      node: process.version,
      electron: process.versions.electron ?? electronPackage.version ?? "unknown",
      transport: "Playwright Svelte UI -> exposed Node binding -> FinancialPageWorkerClient -> worker_threads -> canonical store",
    };
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await actual?.client.close();
    await preflight?.client.close();
    await browser?.close();
    await server?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

async function main() {
  const suiteStartedAt = performance.now();
  const shell = [];
  for (let runNumber = 1; runNumber <= 3; runNumber += 1)
    shell.push({ runNumber, ...(await runShellRuntimeAcceptance()) });
  const pairing = [];
  for (let runNumber = 1; runNumber <= 5; runNumber += 1)
    pairing.push(await runColdPairing(runNumber));
  const suiteElapsedMs = performance.now() - suiteStartedAt;
  assert.ok(suiteElapsedMs < 5 * 60_000, "runtime interaction suite exceeded five minutes");
  console.log(JSON.stringify({
    suiteElapsedMs,
    shell: {
      runs: shell.length,
      shellStartupMs: shell.map((run) => run.shellStartupMs),
      navigationMs: shell.map((run) => run.navigationMs),
      refreshFeedbackMs: shell.map((run) => run.refreshFeedbackMs),
      maxRendererRafGapMs: shell.map((run) => run.rendererEvidence.maxRafGapMs),
      longTaskCounts: shell.map((run) => run.rendererEvidence.longTasks.length),
    },
    pairing: {
      runs: pairing.length,
      prewarmDoneAtClick: pairing.map((run) => run.prewarmDoneAtClick),
      openFeedbackMs: pairing.map((run) => run.openFeedbackMs),
      openMs: pairing.map((run) => run.openMs),
      confirmFeedbackMs: pairing.map((run) => run.confirmFeedbackMs),
      confirmMs: pairing.map((run) => run.confirmMs),
      maxRendererRafGapMs: pairing.map((run) => run.rendererEvidence.maxRafGapMs),
      longTaskCounts: pairing.map((run) => run.rendererEvidence.longTasks.length),
    },
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
