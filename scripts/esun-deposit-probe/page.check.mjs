import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createPageTransport, observePortalRequests, waitForPortalSession } from "./page.ts";

const PORTAL = "https://ebank.esunbank.com.tw";

async function withPortalPage(run, { sessionScript = "window.mibApiService = { uuid: 'session-key' };" } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const posts = [];
    await page.route(`${PORTAL}/**`, async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (request.method() === "GET") {
        await route.fulfill({ contentType: "text/html", body: `<script>${sessionScript}</script>` });
        return;
      }
      posts.push({ pathname, uniqueKey: request.headers().uniquekey, body: request.postDataJSON() });
      if (pathname.endsWith("/broken")) {
        await route.fulfill({ status: 502, contentType: "text/html", body: "<html>gateway</html>" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ resultCode: "0000", txnFlowToken: `flow-${posts.length}`, resultBody: {} }),
      });
    });
    const observed = observePortalRequests(page);
    await page.goto(`${PORTAL}/esb/`);
    await run({ page, posts, observed });
  } finally {
    await browser.close();
  }
}

test("the in-page transport posts the portal envelope and carries the flow token forward", async () => {
  await withPortalPage(async ({ page, posts, observed }) => {
    await waitForPortalSession(page, 5_000);
    const transport = createPageTransport(page, new AbortController().signal);
    const first = await transport("mib-ctw-portal/ctw01/ctw01002/home/init", {}, true);
    const second = await transport("mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail", { account: null }, false);
    const reset = await transport("mib-ctw-portal/ctw01/ctw01002/home/init", {}, true);

    assert.deepEqual(first, { kind: "json", httpStatus: 200, json: { resultCode: "0000", txnFlowToken: "flow-1", resultBody: {} } });
    assert.equal(second.kind, "json");
    assert.equal(reset.kind, "json");
    assert.deepEqual(posts.map(({ pathname, uniqueKey }) => [pathname, uniqueKey]), [
      ["/esb/mib-ctw-portal/ctw01/ctw01002/home/init", "session-key"],
      ["/esb/mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail", "session-key"],
      ["/esb/mib-ctw-portal/ctw01/ctw01002/home/init", "session-key"],
    ]);
    assert.deepEqual(posts.map(({ body }) => body.header.txnFlowToken), ["", "flow-1", ""]);
    assert.deepEqual(posts[1].body.requestBody, { account: null });
    assert.match(posts[0].body.header.txnTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    assert.deepEqual(observed(), [
      "POST /esb/mib-ctw-portal/ctw01/ctw01002/home/init 200",
      "POST /esb/mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail 200",
    ]);
  });
});

test("a non-JSON reply returns only its HTTP status", async () => {
  await withPortalPage(async ({ page }) => {
    const reply = await createPageTransport(page, new AbortController().signal)("x/broken", {}, true);
    assert.deepEqual(reply, { kind: "non-json", httpStatus: 502 });
  });
});

test("a page without the portal session sends nothing", async () => {
  await withPortalPage(async ({ page, posts }) => {
    await waitForPortalSession(page, 200);
    const reply = await createPageTransport(page, new AbortController().signal)("x/init", {}, true);
    assert.deepEqual(reply, { kind: "portal-session-missing" });
    assert.equal(posts.length, 0);
  }, { sessionScript: "" });
});

test("a cancelled probe sends nothing", async () => {
  await withPortalPage(async ({ page, posts }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createPageTransport(page, controller.signal)("x/init", {}, true));
    assert.equal(posts.length, 0);
  });
});
