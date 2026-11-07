import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import {
  CATHAY_CURRENT_DEPOSIT_HOST,
  readCathayCurrentDepositBalanceResponse,
} from "./cathay-current-deposit-balances.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { WITHOUT_PRODUCT_VALIDATION } from "./provider-response-reader.ts";

const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

test("cancelling the run stops a current balance read waiting a minute for the overview response", async () => {
  const page = await browser.newPage();
  try {
    // The menu renders, but opening the overview never sends the POST the read waits for.
    await page.route(`https://${CATHAY_CURRENT_DEPOSIT_HOST}/**`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<button>臺幣</button><button>臺幣帳戶總覽</button>",
      }));
    await page.goto(`https://${CATHAY_CURRENT_DEPOSIT_HOST}/OnlineBanking/`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(
      readCathayCurrentDepositBalanceResponse(page, "domestic", {
        now: () => "2026-09-08T13:20:10.000Z",
        text: strictSourceText,
        validate: WITHOUT_PRODUCT_VALIDATION,
        signal: controller.signal,
      }),
      (error: unknown) => error === CANCELLED,
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await page.close();
  }
});
