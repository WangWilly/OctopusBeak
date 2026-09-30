import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { waitForSignedInState } from "../../../workflows/sinopac-statements.ts";

test("SinoPac terminal service error does not wait for the five-minute login timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await browser.newPage();
    await page.route("https://mma.sinopac.com/**", (route) => route.fulfill({
      contentType: "text/html", body: "本功能暫時無法提供服務，請稍後再試 !",
    }));
    await page.goto("https://mma.sinopac.com/Errors/GenericErrorPage.aspx");
    deadline = setTimeout(() => { void browser.close(); }, 500);
    let reported = false;
    await assert.rejects(waitForSignedInState(page, undefined, async () => { reported = true; }), /SinoPac service is temporarily unavailable/);
    assert.equal(reported, true);
  } finally {
    if (deadline) clearTimeout(deadline);
    await browser.close();
  }
});
