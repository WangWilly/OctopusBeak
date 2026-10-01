import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type APIRequestContext, type Response as BrowserResponse } from "playwright";
import { captureTypedReport, decodeYuantaTradeReportResponse } from "../../../workflows/yuanta-trade-statements.ts";
import { strictSourceText } from "../source-text.ts";
import type { WorkflowContext } from "../workflow-executor.ts";

test("Yuanta report retries a lost browser navigation body with a validated raw POST", async () => {
  const url = "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock";
  const browserResponse = {
    url: () => url,
    status: () => 200,
    request: () => ({ method: () => "POST" }),
    headers: () => ({ "content-type": "text/html; charset=utf-8" }),
    body: async () => { throw new Error("response.body: Protocol error (Network.getResponseBody): No resource with given identifier found"); },
  } as unknown as BrowserResponse;
  let posts = 0;
  const request = {
    post: async (requestedUrl: string, options: { form: Record<string, string> }) => {
      posts++;
      assert.equal(requestedUrl, url);
      assert.deepEqual(options.form, { index: "-1" });
      return {
        url: () => url,
        status: () => 200,
        headers: () => ({ "content-type": "text/html; charset=utf-8" }),
        body: async () => Buffer.from("<script>var currAssetType = 'Stock';</script>"),
      };
    },
  } as unknown as APIRequestContext;
  const report = await decodeYuantaTradeReportResponse(browserResponse, strictSourceText, "Stock", {
    request,
    params: { index: -1 },
  });
  assert.equal(posts, 1);
  assert.equal(report.currentAssetType, "Stock");

  const redirectedRequest = {
    post: async () => ({
      url: () => "https://global.yuanta.com.tw/NexusWebTrade/Login",
      status: () => 200,
      headers: () => ({ "content-type": "text/html; charset=utf-8" }),
      body: async () => Buffer.from("<script>var currAssetType = 'Stock';</script>"),
    }),
  } as unknown as APIRequestContext;
  await assert.rejects(
    decodeYuantaTradeReportResponse(browserResponse, strictSourceText, "Stock", {
      request: redirectedRequest,
      params: { index: -1 },
    }),
    /did not match the requested source/u,
  );
});

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
