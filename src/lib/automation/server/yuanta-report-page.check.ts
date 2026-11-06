import assert from "node:assert/strict";
import test from "node:test";
import type { APIRequestContext, Page, Response as BrowserResponse } from "playwright";
import { launchCheckBrowser } from "../check-browser.fixtures.ts";
import {
  captureTypedReport,
  decodeYuantaTradeReportResponse,
  type YuantaReportReader,
} from "../../../workflows/yuanta-trade-statements.ts";
import { strictSourceText } from "../source-text.ts";

const reader: YuantaReportReader = { text: strictSourceText, validate: async (check) => await check() };

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
  const report = await decodeYuantaTradeReportResponse(browserResponse, reader, "Stock", {
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
    decodeYuantaTradeReportResponse(browserResponse, reader, "Stock", {
      request: redirectedRequest,
      params: { index: -1 },
    }),
    /did not match the requested source/u,
  );
});

test("Yuanta report submission uses the report route when login ends on a different controller", async () => {
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://global.yuanta.com.tw/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<button id="btnLogout">Logout</button><script>var currAssetType = 'Stock';</script>`,
    }));
    await page.goto("https://global.yuanta.com.tw/NexusWebTrade/Main/Index");
    const report = await captureTypedReport(page, "Stock", { index: -1 }, {
      ...reader,
      signal: new AbortController().signal,
    });
    assert.equal(new URL(report.url).pathname, "/NexusWebTrade/AssetReport/Stock");
    assert.equal(report.currentAssetType, "Stock");
  } finally {
    await browser.close();
  }
});

test("cancelling the run stops a Yuanta report read at each of its waits", async () => {
  const browser = await launchCheckBrowser();
  const cancelled = new Error("synthetic cancellation");
  const assertCancelledPromptly = async (landing: string, page: Page) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(cancelled), 500);
    const started = Date.now();
    await assert.rejects(
      captureTypedReport(page, "Stock", { index: -1 }, { ...reader, signal: controller.signal }),
      (error: unknown) => error === cancelled,
      landing,
    );
    assert.ok(Date.now() - started < 2_000, `${landing} stopped promptly`);
  };
  const readCancelledAfter = async (landing: "hang" | "no-logout") => {
    const page = await browser.newPage();
    await page.route("https://global.yuanta.com.tw/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/NexusWebTrade/Main/Index") {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<p>signed in</p>" });
      }
      if (landing === "hang") return;
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<script>var currAssetType = 'Stock';</script>" });
    });
    await page.goto("https://global.yuanta.com.tw/NexusWebTrade/Main/Index");
    await assertCancelledPromptly(landing, page);
    await page.close();
  };
  // Yuanta redirects a failed report query to its error page. Chromium follows a
  // fulfilled redirect on the network, so this page lands there without one.
  const errorLanding = {
    waitForNavigation: async () => ({ url: () => "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Error" }),
    evaluate: async () => undefined,
  } as unknown as Page;
  try {
    await readCancelledAfter("hang");
    await assertCancelledPromptly("error", errorLanding);
    await readCancelledAfter("no-logout");
  } finally {
    await browser.close();
  }
});
