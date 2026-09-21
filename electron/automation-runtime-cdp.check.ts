import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  removeDesktopCdpFixture,
  seedDesktopCdpFixture,
} from "../scripts/seed-desktop-cdp-fixture.ts";

const TASK_ID = "esun-credit-card-statements";
const SECOND_TASK_ID = "fubon-all-statements";
const UNKNOWN_ACTIVE_TASK_ID = "unknown-cdp-active-task";
async function reserveCdpPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local CDP port.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function redacted(value: string, directory: string) {
  return value.replaceAll(directory, "<TEMP>").trim().slice(-2_000);
}

async function waitForCdpEndpoint(cdpUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch {
      // Electron has not opened the debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP endpoint did not become available.");
}

async function waitForRendererPage(browser: Browser, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP renderer page did not become available.");
}

async function waitForRuntimeRun(page: Page, taskId: string) {
  await page.waitForFunction(
    async (candidateTaskId) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.some((task) =>
        task.taskId === candidateTaskId
        && task.runId !== null
        && !["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status),
      );
    },
    taskId,
    { timeout: 2_000 },
  );
}

function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

test("isolated Electron/CDP automation runtime stays synchronized", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-runtime-cdp-"));
  const userData = join(directory, "user-data");
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }> | null = null;
  try {
    seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
    const cdpPort = await reserveCdpPort();
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const main = fileURLToPath(new URL("./main.cjs", import.meta.url));
    let output = "";
    let errorOutput = "";
    child = spawn(
      electronPath,
      ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main],
      {
        cwd: directory,
        env: {
          ...process.env,
          OCTOPUSBEAK_CDP_FIXTURE: "171",
          OCTOPUSBEAK_AUTOMATION_FAKE_RUNNER: "1",
          OCTOPUSBEAK_USER_DATA: userData,
          OCTOPUSBEAK_CDP_PORT: String(cdpPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    exited = new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once("exit", (status, signal) => resolve({ status, signal }));
      child!.once("error", () => resolve({ status: null, signal: null }));
    });
    const launchResult = await Promise.race([
      waitForCdpEndpoint(cdpUrl, 5_000).then(() => ({ ready: true as const })),
      exited.then((result) => ({ ready: false as const, result })),
    ]);
    if (!launchResult.ready) {
      const result = launchResult.result;
      const knownMacElectronInitializationAbort =
        process.platform === "darwin"
        && result.signal === "SIGABRT"
        && result.status === null
        && output.trim() === ""
        && errorOutput.trim() === "";
      if (knownMacElectronInitializationAbort) {
        t.skip("Electron fixture hit the known macOS NSApplication SIGABRT initialization limitation.");
        return;
      }
      assert.fail(`Electron fixture exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
    }
    browser = await chromium.connectOverCDP(cdpUrl);
    const page = await waitForRendererPage(browser, 10_000);
    await page.evaluate(() => { window.location.hash = "#/automation"; });
    const row = page.locator(`#${TASK_ID}-task-row`);
    const secondRow = page.locator(`#${SECOND_TASK_ID}-task-row`);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    await secondRow.waitFor({ state: "visible", timeout: 10_000 });
    const credentialState = await row.locator(".credential-state").innerText();
    assert.doesNotMatch(credentialState, /missing|未設定/i);

    const optimisticStart = await page.evaluate((taskId) => {
      const button = document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      );
      if (!button) throw new Error(`Missing primary action for ${taskId}`);
      const start = performance.now();
      button.click();
      return start;
    }, TASK_ID);
    await page.waitForFunction(
      (taskId) => document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      )?.getAttribute("aria-busy") === "true",
      TASK_ID,
      { timeout: 1_000 },
    );
    const optimisticElapsed = await page.evaluate(
      (start) => performance.now() - start,
      optimisticStart,
    );
    assert.ok(
      optimisticElapsed <= 200,
      `Run click did not render optimistic state within 200ms: ${optimisticElapsed.toFixed(1)}ms`,
    );

    await waitForRuntimeRun(page, TASK_ID);
    const firstRun = page.evaluate((taskId) => window.octopusBeak.automation.run(taskId), TASK_ID);
    const secondRun = page.evaluate((taskId) => window.octopusBeak.automation.run(taskId), TASK_ID);
    const [first, second] = await Promise.all([firstRun, secondRun]);
    assert.equal(first.runId, second.runId);
    assert.match(page.url(), /#\/automation/);
    await row.locator('.task-control[aria-busy="true"]').waitFor({ state: "visible", timeout: 1_000 });
    await row.locator(".progress-cell").waitFor({ state: "visible", timeout: 1_000 });

    const secondOptimisticStart = await page.evaluate((taskId) => {
      const button = document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      );
      if (!button) throw new Error(`Missing primary action for ${taskId}`);
      const start = performance.now();
      button.click();
      return start;
    }, SECOND_TASK_ID);
    await page.waitForFunction(
      (taskId) => document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      )?.getAttribute("aria-busy") === "true",
      SECOND_TASK_ID,
      { timeout: 1_000 },
    );
    const secondOptimisticElapsed = await page.evaluate(
      (start) => performance.now() - start,
      secondOptimisticStart,
    );
    assert.ok(secondOptimisticElapsed <= 200);
    await waitForRuntimeRun(page, SECOND_TASK_ID);
    await secondRow.locator('[data-onboarding-action="primary"]').click();
    await secondRow.locator(".chip").waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await secondRow.innerText(), /cancelled|已取消/i);

    await row.locator(".chip").waitFor({ state: "visible", timeout: 10_000 });
    await row.locator('[data-onboarding-action="logs"]').click();
    await row.locator(".log-output").waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await row.locator(".log-output").innerText(), /fixture-log-entry/);
    assert.match(await row.innerText(), /completed|完成/i);
    assert.doesNotMatch(await secondRow.innerText(), /fixture-log-entry/);
    assert.match(page.url(), /#\/automation/);
    await page.evaluate(() => { window.location.hash = "#/overview"; });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.location.hash = "#/automation"; });
    await row.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await row.innerText(), /completed|完成|fixture/i);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) stopChild(child);
    await Promise.race([
      exited ?? Promise.resolve({ status: null, signal: null }),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    removeDesktopCdpFixture(directory);
  }
});

test("isolated Electron/CDP runtime invariant exits on an unknown active task", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-runtime-fatal-cdp-"));
  const userData = join(directory, "user-data");
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }> | null = null;
  try {
    seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
    const cdpPort = await reserveCdpPort();
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const main = fileURLToPath(new URL("./main.cjs", import.meta.url));
    let output = "";
    let errorOutput = "";
    child = spawn(
      electronPath,
      ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main],
      {
        cwd: directory,
        env: {
          ...process.env,
          OCTOPUSBEAK_CDP_FIXTURE: "171",
          OCTOPUSBEAK_CDP_FATAL_FIXTURE: "unknown-active",
          OCTOPUSBEAK_AUTOMATION_FAKE_RUNNER: "1",
          OCTOPUSBEAK_USER_DATA: userData,
          OCTOPUSBEAK_CDP_PORT: String(cdpPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (status, signal) => resolve({ status, signal }));
      child!.once("error", () => resolve({ status: null, signal: null }));
    });
    const launchResult = await Promise.race([
      waitForCdpEndpoint(cdpUrl, 5_000).then(() => ({ ready: true as const })),
      exited.then((result) => ({ ready: false as const, result })),
    ]);
    if (!launchResult.ready) {
      const result = launchResult.result;
      const knownMacElectronInitializationAbort =
        process.platform === "darwin"
        && result.signal === "SIGABRT"
        && result.status === null
        && output.trim() === ""
        && errorOutput.trim() === "";
      if (knownMacElectronInitializationAbort) {
        t.skip("Electron fixture hit the known macOS NSApplication SIGABRT initialization limitation.");
        return;
      }
      assert.fail(`Fatal fixture exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
    }
    browser = await chromium.connectOverCDP(cdpUrl);
    const page = await waitForRendererPage(browser, 10_000);
    await page.evaluate(() => { window.location.hash = "#/automation"; });
    const result = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "Fatal invariant process did not exit.");
    assert.equal(result?.status, 1);
    const combined = `${output}\n${errorOutput}`;
    assert.match(combined, /automation-runtime-fatal/);
    assert.match(combined, /automation-unknown-active-task/);
    assert.match(combined, new RegExp(UNKNOWN_ACTIVE_TASK_ID));
    assert.match(combined, /unknown-cdp-run/);
    assert.doesNotMatch(combined, /fixture-cdp-/);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) stopChild(child);
    await Promise.race([
      exited ?? Promise.resolve({ status: null, signal: null }),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    removeDesktopCdpFixture(directory);
  }
});
