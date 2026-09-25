import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      const diagnostic = await page.evaluate(async () => {
        let runtimeTasks: Array<{
          taskId: string;
          status: string;
          hasRunId: boolean;
          phaseCode: string | null;
          percent: number | null;
        }> = [];
        let runtimeError: string | null = null;
        try {
          const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
          runtimeTasks = snapshot.tasks.map((task) => ({
            taskId: task.taskId,
            status: task.status,
            hasRunId: task.runId !== null,
            phaseCode: task.progress.phaseCode,
            percent: task.progress.percent,
          }));
        } catch (error) {
          runtimeError = error instanceof Error ? error.name : "unknown";
        }
        const target = window as unknown as {
          __octopusBeakFailureProbe?: {
            eventAt: number | null;
            domAt: number | null;
            renderMs: number | null;
            status: string | null;
            runId: string | null;
          };
        };
        const probe = target.__octopusBeakFailureProbe;
        return {
          rowBusy: [...document.querySelectorAll<HTMLButtonElement>(
            '[data-onboarding-action="primary"]',
          )].map((button) => ({
            taskId: button.closest<HTMLElement>("[id$='-task-row']")?.id ?? "unknown",
            busy: button.getAttribute("aria-busy"),
          })),
          runtimeTasks,
          runtimeError,
          failureProbe: probe ? {
            hasEvent: probe.eventAt !== null,
            hasDom: probe.domAt !== null,
            renderMs: probe.renderMs,
            status: probe.status,
            hasRunId: Boolean(probe.runId),
          } : null,
          blocks: [...document.querySelectorAll<HTMLElement>("[data-progressive-block]")]
            .map((element) => ({
              block: element.dataset.progressiveBlock ?? "unknown",
              state: element.dataset.blockState ?? "unknown",
            })),
        };
      }).catch(() => null);
      throw new Error(`Timed out waiting for Electron page condition after ${timeoutMs}ms: ${JSON.stringify(diagnostic)}`);
    }
    await page.waitForTimeout(Math.min(50, remaining));
  }
}

/** Prevent the typed workflow from opening an external bank page in this fixture. */
function blockAppBrowserLaunch(userData: string) {
  const automationDirectory = join(userData, "data", "automation");
  const browserStateRoot = join(automationDirectory, "browser-state");
  mkdirSync(automationDirectory, { recursive: true });
  rmSync(browserStateRoot, { recursive: true, force: true });
  writeFileSync(browserStateRoot, "CDP fixture blocks browser launch.", "utf8");
  return browserStateRoot;
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

test("isolated Electron/CDP typed App run records and renders a safe failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-runtime-cdp-"));
  const userData = join(directory, "user-data");
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }> | null = null;
  try {
    await seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
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
          OCTOPUSBEAK_USER_DATA: userData,
          OCTOPUSBEAK_CDP_PORT: String(cdpPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    exited = new Promise((resolve) => {
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
    await row.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => {
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-progressive-block]")]
        .filter((element) => ["summary", "details", "list"].includes(element.dataset.progressiveBlock ?? ""));
      return blocks.length === 3 && blocks.every((element) => element.dataset.blockState === "ready");
    }, undefined, { timeout: 10_000 });
    assert.doesNotMatch(await row.locator(".credential-state").innerText(), /missing|未設定/i);

    const previousRunId = await page.evaluate(async (taskId) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.find((task) => task.taskId === taskId)?.runId ?? null;
    }, TASK_ID);
    assert.ok(previousRunId, "Fixture must expose its persisted initial run.");

    // The filesystem obstacle is installed only after App startup. The typed
    // executor creates a real run, then fails while opening its managed browser
    // state root, before Playwright can navigate to the bank.
    const browserStateRoot = blockAppBrowserLaunch(userData);
    const started = await page.evaluate(async (input: { taskId: string; userData: string }) => {
      try {
        const result = await window.octopusBeak.automation.run(input.taskId);
        return { runId: result.runId, errorClass: null as string | null, diagnostic: null as string | null };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "";
        const message = rawMessage
          .replaceAll(input.userData, "<TEMP>")
          .replace(/fixture-cdp-[A-Za-z0-9_-]+/gu, "<FIXTURE>")
          .slice(0, 240);
        const errorClass = message.startsWith("Missing credentials:")
          ? "missing-credentials"
          : message.startsWith("Select at least one ")
            ? "missing-statement-selection"
            : message.includes("disabled")
              ? "task-disabled"
              : error instanceof Error ? error.name : "unknown-error";
        return { runId: null, errorClass, diagnostic: message };
      }
    }, { taskId: TASK_ID, userData });
    assert.ok(started.runId, `App rejected the typed task before creating a run (${started.errorClass ?? "unknown"}): ${started.diagnostic ?? ""}`);
    assert.notEqual(started.runId, previousRunId);

    await waitForPagePredicate(page, async (input: { taskId: string; previousRunId: string }) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const task = snapshot.tasks.find((candidate) => candidate.taskId === input.taskId);
      return task?.runId !== null
        && task?.runId !== input.previousRunId
        && task?.status === "failed";
    }, { taskId: TASK_ID, previousRunId }, 10_000);
    await waitForPagePredicate(page, (taskId: string) => {
      const rowText = document.querySelector<HTMLElement>(`#${taskId}-task-row`)?.textContent ?? "";
      const button = document.querySelector<HTMLButtonElement>(
        `#${taskId}-task-row [data-onboarding-action="primary"]`,
      );
      return /failed|失敗/iu.test(rowText) && button?.getAttribute("aria-busy") === "false";
    }, TASK_ID, 5_000);

    const finalRuntime = await page.evaluate(async (taskId) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
      return task ? {
        runId: task.runId,
        status: task.status,
        phaseCode: task.progress.phaseCode,
      } : null;
    }, TASK_ID);
    assert.equal(finalRuntime?.status, "failed");
    assert.notEqual(finalRuntime?.runId, previousRunId);
    assert.doesNotMatch(JSON.stringify(finalRuntime), /fixture-cdp-|password|account|sourceText/i);
    assert.equal(existsSync(join(browserStateRoot, TASK_ID)), false);
    assert.equal(readFileSync(browserStateRoot, "utf8"), "CDP fixture blocks browser launch.");
    const logDirectory = join(userData, "data", "automation", "logs");
    assert.deepEqual(existsSync(logDirectory) ? readdirSync(logDirectory) : [], []);
    assert.equal(await page.locator('[data-progressive-block="summary"] .block-spinner').count(), 0);
    assert.equal(await page.locator('[data-progressive-block="details"] .block-spinner').count(), 0);
    assert.equal(await page.locator('[data-progressive-block="list"] .block-spinner').count(), 0);

    await page.evaluate(() => { window.location.hash = "#/overview"; });
    await navigateToAutomation(page);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await row.innerText(), /failed|失敗/i);
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

test("isolated Electron/CDP runtime failure event reaches the row within 200ms", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-runtime-failure-cdp-"));
  const userData = join(directory, "user-data");
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }> | null = null;
  try {
    await seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
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
          OCTOPUSBEAK_USER_DATA: userData,
          OCTOPUSBEAK_CDP_PORT: String(cdpPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    exited = new Promise((resolve) => {
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
      assert.fail(`Electron failure fixture exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
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
    assert.doesNotMatch(await row.locator(".credential-state").innerText(), /missing|未設定/i);

    const previousRunId = await page.evaluate(async (taskId) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.find((task) => task.taskId === taskId)?.runId ?? null;
    }, TASK_ID);
    assert.ok(previousRunId, "Fixture must expose its persisted initial run.");
    const browserStateRoot = blockAppBrowserLaunch(userData);

    await page.evaluate((input: { taskId: string; previousRunId: string }) => {
      const target = window as unknown as Record<string, unknown>;
      const probe = {
        eventAt: null as number | null,
        domAt: null as number | null,
        renderMs: null as number | null,
        status: null as string | null,
        runId: null as string | null,
        unsubscribe: null as (() => void) | null,
      };
      const observeRow = () => {
        if (probe.domAt !== null) return;
        const rowElement = document.querySelector<HTMLElement>(`#${input.taskId}-task-row`);
        const button = rowElement?.querySelector<HTMLButtonElement>('[data-onboarding-action="primary"]');
        const ready = Boolean(rowElement && button)
          && /failed|失敗/iu.test(rowElement?.textContent ?? "")
          && button?.getAttribute("aria-busy") === "false";
        if (ready) {
          probe.domAt = performance.now();
          probe.renderMs = probe.domAt - (probe.eventAt ?? probe.domAt);
          return;
        }
        if (performance.now() - (probe.eventAt ?? performance.now()) < 1_000) {
          requestAnimationFrame(observeRow);
        }
      };
      probe.unsubscribe = window.octopusBeak.automation.onRuntimeChanged((snapshot) => {
        const task = snapshot.tasks.find((candidate) => candidate.taskId === input.taskId);
        if (
          !task
          || task.status !== "failed"
          || task.runId === input.previousRunId
          || probe.eventAt !== null
        ) return;
        probe.eventAt = performance.now();
        probe.status = task.status;
        probe.runId = task.runId;
        requestAnimationFrame(observeRow);
      });
      target.__octopusBeakFailureProbe = probe;
    }, { taskId: TASK_ID, previousRunId });

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
    const optimisticElapsed = await page.evaluate((start) => performance.now() - start, optimisticStart);
    assert.ok(optimisticElapsed <= 200, `Run click did not render optimistic state within 200ms: ${optimisticElapsed.toFixed(1)}ms`);

    await waitForPagePredicate(page, () => Boolean(
      (window as unknown as { __octopusBeakFailureProbe?: { domAt: number | null } })
        .__octopusBeakFailureProbe?.domAt,
    ), undefined, 10_000);
    const probe = await page.evaluate(() => {
      const target = window as unknown as {
        __octopusBeakFailureProbe?: {
          eventAt: number | null;
          domAt: number | null;
          renderMs: number | null;
          status: string | null;
          runId: string | null;
          unsubscribe?: (() => void) | null;
        };
      };
      const value = target.__octopusBeakFailureProbe;
      value?.unsubscribe?.();
      return {
        eventAt: value?.eventAt ?? null,
        domAt: value?.domAt ?? null,
        renderMs: value?.renderMs ?? null,
        status: value?.status ?? null,
        runId: value?.runId ?? null,
      };
    });
    assert.equal(probe.status, "failed");
    assert.ok(probe.runId && probe.runId !== previousRunId, "Failure event must identify the new App run.");
    assert.ok(probe.eventAt !== null && probe.domAt !== null);
    assert.ok(probe.renderMs !== null && probe.renderMs <= 200, `Authoritative failure rendered too slowly: ${probe.renderMs}ms`);
    assert.equal(page.url(), initialUrl, "Failure state must appear without a route switch.");
    assert.equal(await row.locator('[data-onboarding-action="primary"]').getAttribute("aria-busy"), "false");
    assert.match(await row.innerText(), /failed|失敗/i);
    assert.equal(existsSync(join(browserStateRoot, TASK_ID)), false);
    assert.equal(readFileSync(browserStateRoot, "utf8"), "CDP fixture blocks browser launch.");
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
    await seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
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
