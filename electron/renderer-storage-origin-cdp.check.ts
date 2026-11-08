import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForCdp(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // The isolated Electron process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP endpoint did not start.");
}

const OLD_RENDERER_URL = pathToFileURL(fileURLToPath(new URL("../build/index.html", import.meta.url))).href;
const WELCOME_KEY = "octopusbeak-welcome-v1";
const LOCALE_KEY = "octopusbeak-locale";
const SIDEBAR_KEY = "octopusbeak-sidebar-collapsed";
const welcome = JSON.stringify({ version: 1, status: "bypassed", currentSlide: 1, bankAutomationChoice: null });

/** Writes preferences the way a release that loaded the renderer from file:// left them. */
function seedFileOriginStorage(electron: string, userData: string, directory: string) {
  const seed = join(directory, "seed-file-origin.cjs");
  writeFileSync(seed, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL(${JSON.stringify(OLD_RENDERER_URL)}).catch(() => {});
  await window.webContents.executeJavaScript(${JSON.stringify(`
    localStorage.setItem(${JSON.stringify(WELCOME_KEY)}, ${JSON.stringify(welcome)});
    localStorage.setItem(${JSON.stringify(LOCALE_KEY)}, "zh-TW");
    localStorage.setItem(${JSON.stringify(SIDEBAR_KEY)}, "1");
  `)});
  window.destroy();
  app.exit(0);
});
`);
  const result = spawnSync(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, seed], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `seeding failed: ${result.stdout} ${result.stderr}`);
}

test("preferences saved under file:// survive the move to app://", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-storage-origin-"));
  const userData = join(directory, "user-data");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const electron = createRequire(import.meta.url)("electron") as string;
  const main = fileURLToPath(new URL("./main.cjs", import.meta.url));
  let child: ChildProcess | null = null;
  let output = "";
  let errorOutput = "";
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    seedFileOriginStorage(electron, userData, directory);
    child = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main], {
      cwd: directory,
      env: { ...process.env, OCTOPUSBEAK_USER_DATA: userData, OCTOPUSBEAK_CDP_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (status, signal) => resolve({ status, signal }));
    });
    const launch = await Promise.race([waitForCdp(url).then(() => true), exited.then(() => false)]);
    if (!launch) {
      const result = await exited;
      if (process.platform === "darwin" && result.signal === "SIGABRT" && !output.trim() && !errorOutput.trim()) {
        t.skip("Electron hit the macOS NSApplication sandbox initialization limitation.");
        return;
      }
      assert.fail(`Electron exited before CDP: ${output.slice(-1000)} ${errorOutput.slice(-1000)}`);
    }
    browser = await chromium.connectOverCDP(url);
    const page = browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    await page.waitForFunction(() => window.location.hash === "#/overview", undefined, { timeout: 15_000 });
    assert.match(page.url(), /^app:\/\/octopusbeak\/index\.html#\/overview$/u);
    assert.deepEqual(
      await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [WELCOME_KEY, LOCALE_KEY, SIDEBAR_KEY]),
      [welcome, "zh-TW", "1"],
    );
    await page.locator("[data-overview-state]").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-Hant", "the saved language applies");
    assert.equal(await page.evaluate(() => window.octopusBeak.dataViews.enabled()), true, "IPC answers the app:// renderer");
    assert.doesNotMatch(errorOutput, /renderer-storage-migration-failed/u);
  } finally {
    if (browser) await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child!.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
