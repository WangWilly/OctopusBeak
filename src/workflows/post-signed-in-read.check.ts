import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser, type Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { productCollectionHandle } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { readPostCurrentDepositBalanceResponse } from "./post-current-deposit-balances.ts";
import { providerResponseReader, WITHOUT_PRODUCT_VALIDATION } from "./provider-response-reader.ts";
import { readPostDepositSource } from "./post-statements.ts";

const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

/** Every iPost page shows one account and the query controls, but no query is ever answered. */
async function withSilentIpost(body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://ipost.post.gov.tw/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `
          <a class="btn_td_orange_dtl" href="#">明細</a>
          <input id="dateType_5" type="radio">
          <label for="dateType_5" onclick="document.body.dataset.ranged = 'yes'; setTimeout(showQuery, 400)">近六個月</label>
          <span>資產總覽</span>
          <script>
            function showQuery() {
              const query = document.createElement("a");
              query.className = "css_btn_class";
              query.href = "#";
              query.textContent = "查詢";
              query.onclick = () => { document.body.dataset.queried = "yes"; };
              document.body.append(query);
            }
          </script>`,
      }));
    await body(page);
  } finally {
    await page.close();
  }
}

const cancelledAfter = (ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  return controller.signal;
};

const settlesWithin = async (read: Promise<unknown>) => {
  const started = Date.now();
  await assert.rejects(read, (error: unknown) => error === CANCELLED);
  return Date.now() - started;
};

test("cancelling the run stops a pending statement query instead of letting it click once the button appears", () =>
  withSilentIpost(async (page) => {
    const controller = new AbortController();
    const context = { now: () => new Date().toISOString(), text: strictSourceText, signal: controller.signal };
    const product = productCollectionHandle({
      ...context,
      stage: () => assert.fail("a cancelled read stages nothing"),
      reportActivity: async () => undefined,
      event: async () => {},
      collectionPeriod: () => assert.fail("Post declares no collection period"),
    });
    const reading = readPostDepositSource(page, {} as never, context as never, product);
    reading.catch(() => undefined);
    await page.waitForFunction(() => document.body.dataset.ranged === "yes");
    controller.abort(CANCELLED);
    assert.ok((await settlesWithin(reading)) < 500);
    await page.locator("a.css_btn_class").waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.dataset.queried), undefined, "the cancelled query never ran");
  }));

test("cancelling the run stops the asset overview waiting a minute for its response", () =>
  withSilentIpost(async (page) => {
    await page.goto("https://ipost.post.gov.tw/pst/index.html");
    const reader = providerResponseReader({
      now: () => new Date().toISOString(),
      text: strictSourceText,
      validate: WITHOUT_PRODUCT_VALIDATION,
    });
    const read = readPostCurrentDepositBalanceResponse(page, { signal: cancelledAfter(500), reader });
    assert.ok((await settlesWithin(read)) < 2_000);
  }));
