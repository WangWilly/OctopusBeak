import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { captureTypedReport } from "../../../workflows/yuanta-trade-statements.ts";
import { strictSourceText } from "../source-text.ts";
import type { WorkflowContext } from "../workflow-executor.ts";

test("Yuanta report submission uses the report route when login ends on a different controller", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://global.yuanta.com.tw/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<button id="btnLogout">Logout</button><script>var currAssetType = 'Stock';</script>`,
    }));
    await page.goto("https://global.yuanta.com.tw/NexusWebTrade/Main/Index");
    const report = await captureTypedReport(page, "Stock", { index: -1 }, {
      text: strictSourceText,
      signal: new AbortController().signal,
    } as WorkflowContext);
    assert.equal(new URL(report.url).pathname, "/NexusWebTrade/AssetReport/Stock");
    assert.equal(report.currentAssetType, "Stock");
  } finally {
    await browser.close();
  }
});
