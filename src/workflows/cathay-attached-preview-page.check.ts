import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { playwrightCathayAttachedPreviewPort } from "./cathay-attached-preview-page.ts";
import { CATHAY_CURRENT_DEPOSIT_HOST } from "./cathay-current-deposit-balances.ts";

const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

/** Every Cathay page loads, but none issues the request the read waits for or finishes rendering. */
async function withSilentCathay(body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`https://${CATHAY_CURRENT_DEPOSIT_HOST}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: "<p>載入中</p>" }));
    await body(page);
  } finally {
    await page.close();
  }
}

const portCancelledAfter = (page: Page, ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  const session = () => ({ jwtToken: "synthetic", customerId: "synthetic", idType: "synthetic" });
  return playwrightCathayAttachedPreviewPort(page, session, { text: strictSourceText, signal: controller.signal });
};

const settlesWithin = async (read: Promise<unknown>) => {
  const started = Date.now();
  await assert.rejects(read, (error: unknown) => error === CANCELLED);
  return Date.now() - started;
};

test("cancelling the run stops an account overview waiting a minute for its response", () =>
  withSilentCathay(async (page) => {
    assert.ok((await settlesWithin(portCancelledAfter(page, 300).domesticOverview())) < 2_000);
  }));

test("cancelling the run stops a card overview waiting for its card status", () =>
  withSilentCathay(async (page) => {
    assert.ok((await settlesWithin(portCancelledAfter(page, 300).cardOverview())) < 2_000);
  }));

test("cancelling the run stops a loan overview waiting for the page to settle", () =>
  withSilentCathay(async (page) => {
    assert.ok((await settlesWithin(portCancelledAfter(page, 300).loanOverview())) < 2_000);
  }));
