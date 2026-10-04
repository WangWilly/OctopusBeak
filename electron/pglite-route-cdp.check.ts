import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  throw new Error("PGlite Electron CDP endpoint did not start.");
}

test("enabled PGlite financial routes use live pages", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-pglite-routes-"));
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
    child = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main], {
      cwd: directory,
      env: {
        ...process.env,
        OCTOPUSBEAK_PGLITE_OPERATIONAL: "1",
        OCTOPUSBEAK_USER_DATA: userData,
        OCTOPUSBEAK_CDP_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (status, signal) => resolve({ status, signal }));
    });
    const launch = await Promise.race([
      waitForCdp(url).then(() => true),
      exited.then(() => false),
    ]);
    if (!launch) {
      const result = await exited;
      if (process.platform === "darwin" && result.signal === "SIGABRT" && !output.trim() && !errorOutput.trim()) {
        t.skip("Electron hit the macOS NSApplication sandbox initialization limitation.");
        return;
      }
      assert.fail(`Electron exited before CDP: ${output.slice(-1000)} ${errorOutput.slice(-1000)}`);
    }
    try {
      browser = await chromium.connectOverCDP(url);
    } catch (error) {
      assert.fail(`Electron CDP closed during connection: ${String(error)}; exit=${child.exitCode ?? child.signalCode ?? "running"}; stdout=${output.slice(-4000)}; stderr=${errorOutput.slice(-4000)}`);
    }
    const page = browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    await page.waitForFunction(() => window.location.hash === "#/overview", undefined, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.octopusBeak.dataViews.enabled()), true);

    // A new database legitimately triggers welcome. Bypass only that visual
    // overlay so this fixture can inspect the financial routes themselves.
    await page.evaluate(() => localStorage.setItem("octopusbeak-welcome-v1", JSON.stringify({
      version: 1, status: "bypassed", currentSlide: 1, bankAutomationChoice: null,
    })));
    await page.reload();
    await page.locator("[data-overview-state]").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.locator(".route-error").count(), 0);
    await page.locator('nav.side-nav a[href="#/spending"]').click();
    await page.waitForFunction(() => window.location.hash === "#/spending", undefined, { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector(".route-skeleton, .route-error"), undefined, { timeout: 15_000 });
    assert.equal(await page.locator("[data-financial-live-error]").count(), 0);
    await page.locator(".refresh-trigger").click();
    await page.waitForFunction(() => document.querySelector(".refresh-trigger")?.getAttribute("data-refresh-state") !== "refreshing", undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".route-error").count(), 0);
    await page.locator('nav.side-nav a[href="#/overview"]').click();
    await page.locator("[data-overview-state]").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.locator(".route-error").count(), 0);

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
