import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import {
  CATHAY_CURRENT_DEPOSIT_HOST,
  readCathayCurrentDepositBalanceResponse,
} from "./cathay-current-deposit-balances.ts";

const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
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
      readCathayCurrentDepositBalanceResponse(page, "domestic", controller.signal),
      (error: unknown) => error === CANCELLED,
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await page.close();
  }
});
