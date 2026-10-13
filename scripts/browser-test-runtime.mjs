import { chromium } from "playwright";
import { createSpendingViteServer } from "./spending-browser-harness.mjs";

const RUNTIME_ENV = "OCTOPUSBEAK_BROWSER_TEST_RUNTIME";

/** Lane-owned resources. Only the owner closes the browser server and Vite. */
export async function startBrowserTestRuntime() {
  const server = await createSpendingViteServer();
  let browserServer;
  try {
    browserServer = await chromium.launchServer({ headless: true, host: "127.0.0.1" });
    return {
      env: {
        [RUNTIME_ENV]: JSON.stringify({
          url: server.resolvedUrls.local[0],
          endpoint: browserServer.wsEndpoint(),
        }),
      },
      async close() {
        try {
          await browserServer.close();
        } finally {
          await server.close();
        }
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** A file borrows the lane runtime, or owns one when executed independently. */
export async function acquireBrowserTestRuntime() {
  const owner = process.env[RUNTIME_ENV] ? null : await startBrowserTestRuntime();
  let browser;
  try {
    const { url, endpoint } = JSON.parse(process.env[RUNTIME_ENV] ?? owner.env[RUNTIME_ENV]);
    browser = await chromium.connect(endpoint);
    return {
      url,
      async newPage(t, options = {}) {
        const context = await browser.newContext(options);
        // Register before creating the page: setup and assertion failures also clean up.
        t.after(() => context.close());
        return context.newPage();
      },
      async close() {
        try {
          // A connected browser closes only this client's contexts and connection.
          await browser.close();
        } finally {
          await owner?.close();
        }
      },
    };
  } catch (error) {
    await owner?.close();
    throw error;
  }
}
