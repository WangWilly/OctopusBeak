import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { FrameScopeTimeoutError, type BrowserScope } from "./frame-scope.ts";
import {
  HNCB_CURRENT_DEPOSIT_DETAIL_ROUTE,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE,
} from "./hncb-current-deposit-balances.ts";
import {
  HNCB_NETBANK_ORIGIN,
  HNCB_TRX_DISPATCHER_PATH,
  hncbNetbankSite,
  hncbTrxUrl,
  type HncbRoute,
} from "./hncb-netbank-site.ts";

const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

type Served = { requests: string[] };

const DETAIL_TABLE = `<table><tr><th>帳號(由小到大排序)</th><th>帳上餘額</th></tr><tr><td>0001</td><td>1</td></tr></table>`;
const OVERVIEW_TABLE = `<table><tr>${["帳號", "類別", "幣別", "帳上餘額", "可用餘額", "折合新台幣", "薪轉利率", "餘額查詢", "明細查詢", "轉帳"]
  .map((cell) => `<td>${cell}</td>`).join("")}</tr></table>`;

// The left menu: 帳務查詢 posts to the TrxDispatcher, whose reply lists 帳戶總覽 and 餘額查詢.
const MENU = `<form method="post" action="${HNCB_TRX_DISPATCHER_PATH}"><input type="hidden" name="trx" value="com.lb.wibc.trx.Menu" /></form>
<a href="#" onclick="document.forms[0].submit(); return false;">帳務查詢</a>`;
const ACCOUNTING_MENU = `<a href="${HNCB_TRX_DISPATCHER_PATH}?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt" target="main">帳戶總覽</a>
<a href="#" onclick="document.getElementById('balances').hidden = false; return false;">餘額查詢</a>
<div id="balances" hidden><a href="${HNCB_TRX_DISPATCHER_PATH}?trx=com.lb.wibc.trx.EAccDDSummary" target="main">活期存款</a></div>`;

async function withHncbShell(
  body: (page: Page, served: Served) => Promise<void>,
  options: Readonly<{ shell?: "frameset" | "no-main"; stallTrx?: string }> = {},
): Promise<void> {
  const page = await browser.newPage();
  const served: Served = { requests: [] };
  try {
    await page.route(`${HNCB_NETBANK_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const posted = new URLSearchParams(request.postData() ?? "");
      const trx = posted.get("trx") ?? url.searchParams.get("trx");
      served.requests.push(`${request.method()} ${url.pathname}${url.search}${request.postData() ? ` ${request.postData()}` : ""}`);
      const html = (content: string) =>
        route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: content });
      if (url.pathname === "/netbank/shell") {
        return await html(options.shell === "no-main"
          ? `<p>signed out</p>`
          : `<iframe name="menu" src="/netbank/menu"></iframe><iframe name="main" src="${HNCB_TRX_DISPATCHER_PATH}?trx=com.lb.wibc.trx.Main"></iframe>`);
      }
      if (url.pathname === "/netbank/menu") return await html(MENU);
      if (url.pathname !== HNCB_TRX_DISPATCHER_PATH) return await html(`<p>${url.pathname}</p>`);
      if (trx === options.stallTrx) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return await html(`<p>late</p>`).catch(() => undefined);
      }
      switch (trx) {
        case "com.lb.wibc.trx.Menu":
          return await html(ACCOUNTING_MENU);
        case "com.lb.wibc.trx.AcctInfoInq":
          return await html(`${OVERVIEW_TABLE}<a id="detail" href="?trx=com.lb.wibc.trx.InqMain&acct=1">明細</a>`);
        case "com.lb.wibc.trx.EAccDDSummary":
          return await html(DETAIL_TABLE);
        case "com.lb.wibc.trx.CrdDetailInq":
          return await html(`<p id="card">RANGE=${posted.get("RANGE")} TYPE=${posted.get("TYPE")} state=${posted.get("state")}</p>`);
        case "com.lb.wibc.trx.InqMain":
          return await html(`<form name="form1" method="post" action="${HNCB_TRX_DISPATCHER_PATH}">
            <input type="hidden" name="trx" value="com.lb.wibc.trx.InqResult" /><input name="acct1" value="0001" /></form>
            <a href="javascript:doSubmit()">查詢</a><script>function doSubmit() { document.forms.form1.submit(); }</script>`);
        case "com.lb.wibc.trx.InqResult":
          return await html(`<p id="result">acct1=${posted.get("acct1")}</p>`);
        default:
          return await html(`<p>${trx}</p>`);
      }
    });
    await page.goto(`${HNCB_NETBANK_ORIGIN}/netbank/shell`, { waitUntil: "load" });
    await body(page, served);
  } finally {
    await page.close();
  }
}

const site = (page: Page, signal = new AbortController().signal) => hncbNetbankSite(page, { signal });
const attached = (selector: string) => async (scope: BrowserScope) =>
  (await scope.locator(selector).count().catch(() => 0)) > 0;
const frameName = (scope: BrowserScope) => ("name" in scope ? scope.name() : "page");

const OVERVIEW: HncbRoute = {
  description: "the statement detail link",
  via: { trx: "com.lb.wibc.trx.AcctInfoInq", state: "prompt" },
  ready: attached("#detail"),
};

test("main() finds the main frame of the signed-in frameset", () =>
  withHncbShell(async (page) => {
    assert.equal((await site(page).main()).name(), "main");
  }));

test("a missing main frame times out naming the frame it waited for", () =>
  withHncbShell(async (page) => {
    await assert.rejects(
      site(page).main({ timeoutMs: 300 }),
      (error: unknown) => error instanceof FrameScopeTimeoutError && /frame "main"/u.test(error.message),
    );
  }, { shell: "no-main" }));

test("a transaction route opens in main from another signed-in page and returns its reply", () =>
  withHncbShell(async (page, served) => {
    const hncb = site(page);
    await (await hncb.main()).goto(hncbTrxUrl("com.lb.wibc.trx.CrdDetailInq", "prompt"));
    const { scope, reply } = await hncb.open(OVERVIEW);
    assert.equal(frameName(scope), "main");
    assert.equal(reply.url(), hncbTrxUrl("com.lb.wibc.trx.AcctInfoInq", "prompt"));
    assert.ok(served.requests.includes(`GET ${HNCB_TRX_DISPATCHER_PATH}?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt`));
  }));

test("the overview menu route waits for the accounting POST, then clicks 帳戶總覽 in the menu frame", () =>
  withHncbShell(async (page, served) => {
    const { scope, reply } = await site(page).open(HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE);
    assert.equal(frameName(scope), "main");
    assert.equal(new URL(reply.url()).searchParams.get("trx"), "com.lb.wibc.trx.AcctInfoInq");
    assert.equal(reply.request().method(), "GET");
    assert.ok(served.requests.some((line) => line.startsWith(`POST ${HNCB_TRX_DISPATCHER_PATH} trx=com.lb.wibc.trx.Menu`)));
  }));

test("the balance menu route clicks 帳務查詢, 餘額查詢 and 活期存款 and returns the balance-page reply", () =>
  withHncbShell(async (page) => {
    const { scope, reply } = await site(page).open(HNCB_CURRENT_DEPOSIT_DETAIL_ROUTE);
    assert.equal(frameName(scope), "main");
    assert.equal(new URL(reply.url()).searchParams.get("trx"), "com.lb.wibc.trx.EAccDDSummary");
  }));

test("dispatch posts the transaction fields into main and resolves on the dispatcher reply", () =>
  withHncbShell(async (page, served) => {
    const hncb = site(page);
    const reply = await hncb.dispatch("com.lb.wibc.trx.CrdDetailInq", { state: "result", TYPE: "001", RANGE: "2" });
    assert.equal(reply.request().method(), "POST");
    assert.equal(new URL(reply.url()).pathname, HNCB_TRX_DISPATCHER_PATH);
    assert.deepEqual(
      Object.fromEntries(new URLSearchParams(reply.request().postData() ?? "")),
      { state: "result", TYPE: "001", RANGE: "2", trx: "com.lb.wibc.trx.CrdDetailInq" },
    );
    assert.equal(reply.request().frame().name(), "main");
    assert.equal(await (await hncb.main()).locator("#card").textContent(), "RANGE=2 TYPE=001 state=result");
    assert.equal(served.requests.filter((line) => line.startsWith("POST")).length, 1);
  }));

test("submit clicks the main frame's own form control and resolves on its reply", () =>
  withHncbShell(async (page) => {
    const hncb = site(page);
    const main = await hncb.main();
    await main.goto(hncbTrxUrl("com.lb.wibc.trx.InqMain", "prompt"));
    const reply = await hncb.submit(main.locator('a[href="javascript:doSubmit()"]'));
    assert.equal(reply.request().method(), "POST");
    assert.equal(await (await hncb.main()).locator("#result").textContent(), "acct1=0001");
  }));

test("cancelling the run interrupts a dispatch waiting on its reply", () =>
  withHncbShell(async (page) => {
    const controller = new AbortController();
    const dispatching = site(page, controller.signal).dispatch("com.lb.wibc.trx.Stalled", { state: "result" });
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(dispatching, (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
  }, { stallTrx: "com.lb.wibc.trx.Stalled" }));

test("cancelling the run interrupts a route that never becomes ready", () =>
  withHncbShell(async (page) => {
    const controller = new AbortController();
    const opening = site(page, controller.signal).open({ ...OVERVIEW, ready: attached("#never") });
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(opening, (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
  }));
