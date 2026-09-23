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
      if (response.ok) {
        const metadata = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof metadata.webSocketDebuggerUrl === "string") {
          return metadata.webSocketDebuggerUrl;
        }
      }
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

/** Wait for the renderer's initial overview mount before using route links. */
async function navigateToAutomation(page: Page) {
  await page.waitForFunction(
    () => window.location.hash === "#/overview"
      && Boolean(document.querySelector('[data-onboarding="nav-automation"]')),
    undefined,
    { timeout: 10_000 },
  );
  await page.locator('[data-onboarding="nav-automation"]').click();
  await page.waitForFunction(
    () => window.location.hash === "#/automation",
    undefined,
    { timeout: 10_000 },
  );
}

/** Playwright's bundled waitForFunction does not await async predicates here. */
async function waitForPagePredicate<Arg>(
  page: Page,
  predicate: (arg: Arg) => boolean | Promise<boolean>,
  arg: Arg,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await page.evaluate(predicate as never, arg) as boolean) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const diagnostic = await page.evaluate(() => ({
        secondRow: document.querySelector("#fubon-all-statements-task-row")?.textContent,
        summary: document.querySelector('[data-progressive-block="summary"]')?.textContent?.slice(0, 180),
      })).catch(() => null);
      throw new Error(`Timed out waiting for Electron page condition after ${timeoutMs}ms: ${JSON.stringify(diagnostic)}`);
    }
    await page.waitForTimeout(Math.min(50, remaining));
  }
}

async function waitForRuntimeRun(page: Page, taskId: string) {
  await waitForPagePredicate(page, async (candidateTaskId: string) => {
    const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
    return snapshot.tasks.some((task) =>
      task.taskId === candidateTaskId
      && task.runId !== null
      && !["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status),
    );
  }, taskId, 2_000);
}

function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

function assertUnknownActiveFatalOutput(
  output: string,
  errorOutput: string,
  result: { status: number | null; signal: NodeJS.Signals | null },
) {
  assert.equal(result.status, 1);
  const combined = `${output}\n${errorOutput}`;
  assert.match(combined, /automation-runtime-fatal/);
  assert.match(combined, /automation-unknown-active-task/);
  assert.match(combined, new RegExp(UNKNOWN_ACTIVE_TASK_ID));
  assert.match(combined, /unknown-cdp-run/);
  assert.doesNotMatch(combined, /fixture-cdp-/);
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
    await navigateToAutomation(page);
    const row = page.locator(`#${TASK_ID}-task-row`);
    const secondRow = page.locator(`#${SECOND_TASK_ID}-task-row`);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    await secondRow.waitFor({ state: "visible", timeout: 10_000 });

    // Block data must settle independently. A route switch is deliberately
    // not part of this assertion: the dashboard should leave loading once
    // same-page block requests complete, and only the summary block may own
    // a visible refresh spinner.
    await page.waitForFunction(() => {
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-progressive-block]")]
        .filter((element) => ["summary", "details", "list"].includes(element.dataset.progressiveBlock ?? ""));
      return blocks.length === 3 && blocks.every((element) => element.dataset.blockState === "ready");
    }, undefined, { timeout: 10_000 });
    assert.equal(await page.locator('[data-progressive-block="details"] .block-spinner').count(), 0);
    assert.equal(await page.locator('[data-progressive-block="list"] .block-spinner').count(), 0);

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
    await waitForPagePredicate(page, async (taskId: string) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
      const fill = document.querySelector<HTMLElement>(
        `#${taskId}-task-row .progress-bar > span`,
      );
      return task?.runId !== null
        && task?.status === "running"
        && task.progress.percent !== null
        && task.progress.percent >= 33
        && fill?.style.width === `${task.progress.percent}%`;
    }, TASK_ID, 2_500);
    const runningProgress = await row.locator(".progress-bar > span").evaluate((element) => element.style.width);
    assert.equal(runningProgress, "33%");
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
    await waitForPagePredicate(page, async () => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const activeCount = snapshot.tasks.filter((task) =>
        ["preparing", "running", "retrying", "cancelling", "waiting_for_human"].includes(task.status)
      ).length;
      const heading = document.querySelector<HTMLElement>(
        '[data-progressive-block="summary"] .sync-hero h2',
      );
      return activeCount === 2 && Boolean(heading?.textContent?.includes(String(activeCount)));
    }, undefined, 1_000);
    let cancelDialogError: unknown;
    let cancelDialogSeen = false;
    page.once("dialog", async (dialog) => {
      cancelDialogSeen = true;
      try {
        assert.equal(dialog.type(), "confirm");
        await dialog.accept();
      }
      catch (error) {
        cancelDialogError = error;
        await dialog.dismiss().catch(() => {});
      }
    });
    await secondRow.locator('[data-onboarding-action="primary"]').click();
    assert.equal(cancelDialogError, undefined);
    assert.equal(cancelDialogSeen, true, "cancellation must present its confirmation dialog");
    await waitForPagePredicate(page, async (taskId: string) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.some((task) => task.taskId === taskId && task.status === "cancelled");
    }, SECOND_TASK_ID, 5_000);
    await waitForPagePredicate(page, (taskId: string) => /cancelled|已取消/iu.test(
      document.querySelector<HTMLElement>(`#${taskId}-task-row`)?.textContent ?? "",
    ), SECOND_TASK_ID, 5_000);
    assert.match(await secondRow.innerText(), /cancelled|已取消/i);
    await waitForPagePredicate(page, async () => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const activeCount = snapshot.tasks.filter((task) =>
        ["preparing", "running", "retrying", "cancelling", "waiting_for_human"].includes(task.status)
      ).length;
      const heading = document.querySelector<HTMLElement>(
        '[data-progressive-block="summary"] .sync-hero h2',
      );
      const hero = document.querySelector<HTMLElement>(
        '[data-progressive-block="summary"] .sync-hero',
      );
      return activeCount <= 1
        && hero?.classList.contains("active") === (activeCount > 0)
        && (activeCount === 0 || Boolean(heading?.textContent?.includes(String(activeCount))));
    }, undefined, 1_000);

    await waitForPagePredicate(page, async (taskId: string) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.some((task) => task.taskId === taskId && task.status === "completed");
    }, TASK_ID, 10_000);
    await row.locator(".progress-bar").waitFor({ state: "visible", timeout: 2_000 });
    await row.locator('[data-onboarding-action="logs"]').click();
    const logOutput = page.locator(`#${TASK_ID}-inline-log .log-output`);
    await logOutput.waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await logOutput.innerText(), /fixture-log-entry/);
    assert.match(await row.innerText(), /completed|完成/i);
    await waitForPagePredicate(page, async (taskId: string) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
      const button = document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      );
      const fill = document.querySelector<HTMLElement>(
        `#${taskId}-task-row .progress-bar > span`,
      );
      return task?.status === "completed"
        && task.progress.percent === 100
        && button?.getAttribute("aria-busy") === "false"
        && !/cancel|取消/i.test(button.textContent ?? "")
        && fill?.style.width === "100%";
    }, TASK_ID, 2_000);
    assert.equal(await page.locator('[data-progressive-block="summary"] .block-spinner').count(), 0);
    assert.doesNotMatch(await secondRow.innerText(), /fixture-log-entry/);
    assert.match(page.url(), /#\/automation/);
    await page.evaluate(() => { window.location.hash = "#/overview"; });
    await page.waitForTimeout(100);
    await navigateToAutomation(page);
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

test("isolated Electron/CDP partial runtime updates the current row within 200ms", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-runtime-partial-cdp-"));
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
          OCTOPUSBEAK_AUTOMATION_FAKE_RESULT: "partial",
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
      assert.fail(`Electron partial fixture exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
    }

    browser = await chromium.connectOverCDP(cdpUrl);
    const page = await waitForRendererPage(browser, 10_000);
    await navigateToAutomation(page);
    const initialUrl = page.url();
    const row = page.locator(`#${TASK_ID}-task-row`);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => {
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-progressive-block]")]
        .filter((element) => ["summary", "details", "list"].includes(element.dataset.progressiveBlock ?? ""));
      return blocks.length === 3 && blocks.every((element) => element.dataset.blockState === "ready");
    }, undefined, { timeout: 10_000 });
    const credentialState = await row.locator(".credential-state").innerText();
    assert.doesNotMatch(credentialState, /missing|未設定/i);

    await page.evaluate((taskId) => {
      const target = window as unknown as Record<string, unknown>;
      const probe = {
        eventAt: null as number | null,
        domAt: null as number | null,
        renderMs: null as number | null,
        status: null as string | null,
        runId: null as string | null,
        unsubscribe: null as (() => void) | null,
      };
      const renderPartial = () => {
        if (probe.domAt !== null) return;
        const rowElement = document.querySelector<HTMLElement>(`#${taskId}-task-row`);
        const button = rowElement?.querySelector<HTMLButtonElement>('[data-onboarding-action="primary"]');
        const progress = rowElement?.querySelector<HTMLElement>('[role="progressbar"]');
        const partialHint = document.querySelector<HTMLElement>(".partial-task-detail");
        const ready = Boolean(rowElement && button && progress && partialHint)
          && progress?.getAttribute("aria-valuenow") === "100"
          && button?.getAttribute("aria-busy") === "false"
          && !/cancel|取消/i.test(button?.textContent ?? "")
          && /fixture partial failure/i.test(partialHint?.textContent ?? "");
        if (ready) {
          probe.domAt = performance.now();
          probe.renderMs = probe.domAt - (probe.eventAt ?? probe.domAt);
          return;
        }
        if (performance.now() - (probe.eventAt ?? performance.now()) < 1_000) {
          requestAnimationFrame(renderPartial);
        }
      };
      probe.unsubscribe = window.octopusBeak.automation.onRuntimeChanged((snapshot) => {
        const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
        if (!task || task.status !== "partial" || probe.eventAt !== null) return;
        probe.eventAt = performance.now();
        probe.status = task.status;
        probe.runId = task.runId;
        requestAnimationFrame(renderPartial);
      });
      target.__octopusBeakPartialProbe = probe;
    }, TASK_ID);

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
    assert.ok(optimisticElapsed <= 200, `Partial run click was not immediately visible: ${optimisticElapsed.toFixed(1)}ms`);

    await page.waitForFunction(
      () => Boolean((window as unknown as { __octopusBeakPartialProbe?: { domAt: number | null } })
        .__octopusBeakPartialProbe?.domAt),
      undefined,
      { timeout: 10_000 },
    );
    const probe = await page.evaluate(() => {
      const target = window as unknown as {
        __octopusBeakPartialProbe?: {
          eventAt: number | null;
          domAt: number | null;
          renderMs: number | null;
          status: string | null;
          runId: string | null;
          unsubscribe?: (() => void) | null;
        };
      };
      const value = target.__octopusBeakPartialProbe;
      value?.unsubscribe?.();
      return {
        eventAt: value?.eventAt ?? null,
        domAt: value?.domAt ?? null,
        renderMs: value?.renderMs ?? null,
        status: value?.status ?? null,
        runId: value?.runId ?? null,
      };
    });
    assert.equal(probe.status, "partial");
    assert.ok(probe.runId, "Partial runtime update must identify a run.");
    assert.ok(probe.eventAt !== null && probe.domAt !== null);
    assert.ok(probe.renderMs !== null && probe.renderMs <= 200, `Authoritative partial event rendered too slowly: ${probe.renderMs}ms`);
    assert.equal(page.url(), initialUrl, "Partial state must appear without a route switch.");
    assert.equal(await row.locator('[data-onboarding-action="primary"]').getAttribute("aria-busy"), "false");
    assert.match(await row.innerText(), /100%/);
    assert.equal(await page.locator(".partial-task-detail").count(), 1);
    await page.locator(".partial-task-detail summary").click();
    assert.match(await page.locator(".partial-task-detail").innerText(), /fixture partial failure/);
    assert.equal(await page.locator('[data-progressive-block="summary"] .block-spinner').count(), 0);
    assert.equal(await page.locator('[data-progressive-block="details"] .block-spinner').count(), 0);
    assert.equal(await page.locator('[data-progressive-block="list"] .block-spinner').count(), 0);
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
      waitForCdpEndpoint(cdpUrl, 5_000).then((webSocketUrl) => ({ ready: true as const, webSocketUrl })),
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
      if (result.status === 1 && /automation-unknown-active-task/.test(`${output}\n${errorOutput}`)) {
        assertUnknownActiveFatalOutput(output, errorOutput, result);
        return;
      }
      assert.fail(`Fatal fixture exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
    }
    browser = await chromium.connectOverCDP(launchResult.webSocketUrl, { timeout: 5_000 }).catch(async (error) => {
      const result = await Promise.race([
        exited!,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]);
      if (result?.status === 1 && /automation-unknown-active-task/.test(`${output}\n${errorOutput}`)) {
        assertUnknownActiveFatalOutput(output, errorOutput, result);
        return null;
      }
      throw new Error(
        `Fatal fixture CDP connection failed: ${String(error)}; childExit=${String(child?.exitCode)} childSignal=${String(child?.signalCode)} stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`,
      );
    });
    if (!browser) return;
    const page = await waitForRendererPage(browser, 10_000);
    await navigateToAutomation(page);
    const result = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "Fatal invariant process did not exit.");
    assertUnknownActiveFatalOutput(output, errorOutput, result!);
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
