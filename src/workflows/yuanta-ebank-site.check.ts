import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import type { BrowserScope } from "./frame-scope.ts";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite, yuantaRouteUrl, type YuantaRoute } from "./yuanta-ebank-site.ts";

const CID = "synthetic-cid";
const CANCELLED = new Error("synthetic cancellation");
const BIG5_ACCOUNT_HEADER = Buffer.from([0xb1, 0x62, 0xb8, 0xb9]); // 帳號

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

type Served = { paths: string[] };

const DEPOSIT_FORM = `<form name="jform" method="post" action="/nib/tx/transactiondetails">
  <select id="acctno"><option value="1">0012-34</option></select>
  <div id="duration"><a href="#" onclick="return pick(this)">一週</a><a href="#" onclick="return pick(this)">自訂</a></div>
  <input id="sdate" /><input id="edate" />
  <a id="csv" href="/nib/tx/export.csv">下載CSV檔</a>
</form>
<script>window.picked = []; function pick(link) { window.picked.push(link.textContent); return false; }</script>`;

async function withYuantaShell(
  body: (page: Page, served: Served) => Promise<void>,
  options: Readonly<{ shell?: "frameset" | "no-fmain"; cidInUrl?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  const served: Served = { paths: [] };
  try {
    await page.route(`${YUANTA_EBANK_ORIGIN}/**`, (route) => {
      const url = new URL(route.request().url());
      served.paths.push(`${url.pathname}${url.search}`);
      const html = (body: string) =>
        void route.fulfill({ contentType: "text/html; charset=utf-8", body });
      switch (url.pathname) {
        case "/nib/shell.jsp":
          return html(options.shell === "no-fmain"
            ? `<p>signed out</p>`
            : `<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home"></iframe>`);
        case "/nib/menu.jsp":
          return html(`<a href="#">選單</a><script>
            window.menuaction = (action, id, flag) => {
              parent.menuCalls = [...(parent.menuCalls ?? []), [action, id, flag]];
              parent.frames.fmain.location.href = "/nib/tx/" + action + (action.includes("?") ? "&" : "?") + "menu=" + id;
            };
          </script>`);
        case "/nib/tx/home":
          return html(options.cidInUrl === false ? `<input name="cid" value="${CID}" /><p>首頁</p>` : `<p>首頁</p>`);
        case "/nib/tx/transactiondetails":
          return html(url.searchParams.get("cid") === CID ? DEPOSIT_FORM : `<p>連線逾時</p>`);
        case "/nib/tx/fundsummary":
          // Like the fund pages, the route alone renders a shell; menuaction() renders the tables.
          return html(url.searchParams.get("menu") === "menu_fundSummary"
            ? `<table id="fund"><tr><th>基金名稱</th></tr></table>`
            : `<p>請由選單進入</p>`);
        case "/nib/tx/summary":
          return html(`<div id="summary">帳戶總覽</div>`);
        case "/nib/tx/never":
          return html(`<p>載入中</p>`);
        case "/nib/tx/export.csv":
          return void route.fulfill({
            contentType: "text/csv",
            headers: { "content-disposition": "attachment; filename=deposit.csv" },
            body: Buffer.concat([BIG5_ACCOUNT_HEADER, Buffer.from(",1\r\n")]),
          });
        case "/nib/tx/bad.html":
          return void route.fulfill({ contentType: "text/html", body: Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]) });
        default:
          return html(`<p>${url.pathname}</p>`);
      }
    });
    const shellUrl = options.cidInUrl === false
      ? `${YUANTA_EBANK_ORIGIN}/nib/shell.jsp`
      : `${YUANTA_EBANK_ORIGIN}/nib/shell.jsp?cid=${CID}`;
    await page.goto(shellUrl, { waitUntil: "load" });
    if (options.cidInUrl !== false && options.shell !== "no-fmain") {
      await page.frame({ name: "fmain" })?.goto(yuantaRouteUrl("home", CID), { waitUntil: "load" });
    }
    await body(page, served);
  } finally {
    await page.close();
  }
}

const context = (signal = new AbortController().signal) => ({ signal, text: strictSourceText });

const attached = (selector: string) => async (scope: BrowserScope) =>
  (await scope.locator(selector).count().catch(() => 0)) > 0;

const DEPOSIT: YuantaRoute = { path: "transactiondetails", description: "deposit form", ready: attached("#acctno") };
const FUND: YuantaRoute = {
  path: "fundsummary?TxnType=FundSummary",
  description: "fund summary tables",
  ready: attached("#fund"),
  menuId: "menu_fundSummary",
};

const frameName = (scope: BrowserScope) => ("name" in scope ? scope.name() : "page");

test("a route opens in fmain with the session's cid and returns the scope that shows it", () =>
  withYuantaShell(async (page, served) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(DEPOSIT);
    assert.equal(frameName(scope), "fmain");
    assert.ok(served.paths.includes(`/nib/tx/transactiondetails?type=page&cid=${CID}`));
    assert.equal(await page.evaluate(() => (window as { menuCalls?: unknown }).menuCalls), undefined);
  }));

test("the cid comes from a page's cid field when no frame URL carries it", () =>
  withYuantaShell(async (page, served) => {
    const site = yuantaEbankSite(page, context());
    assert.equal(await site.cid(), CID);
    await site.open(DEPOSIT);
    assert.ok(served.paths.includes(`/nib/tx/transactiondetails?type=page&cid=${CID}`));
  }, { cidInUrl: false }));

test("a route that renders no page falls back to the provider's menuaction()", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(FUND);
    assert.equal(await scope.locator("#fund").count(), 1);
    assert.deepEqual(
      await page.evaluate(() => (window as { menuCalls?: unknown }).menuCalls),
      [["fundsummary?TxnType=FundSummary", "menu_fundSummary", "N"]],
    );
  }));

test("an optional-cid route opens without a cid, and a required one fails as a lost session", () =>
  withYuantaShell(async (page, served) => {
    const site = yuantaEbankSite(page, context());
    await page.frame({ name: "fmain" })?.goto(`${YUANTA_EBANK_ORIGIN}/nib/tx/blank`);
    const summary = await site.open({ path: "summary", description: "summary", ready: attached("#summary"), cid: "optional" });
    assert.equal(await summary.locator("#summary").count(), 1);
    assert.ok(served.paths.includes("/nib/tx/summary"));
    await assert.rejects(
      site.open(DEPOSIT),
      (error: unknown) => error instanceof FailureCodeError && error.errorCode === "authentication-failed",
    );
  }, { cidInUrl: false }));

test("a shell without fmain fails as a lost session", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    await assert.rejects(
      site.open(DEPOSIT),
      (error: unknown) => error instanceof FailureCodeError && error.errorCode === "authentication-failed",
    );
  }, { shell: "no-fmain" }));

test("cancelling the run interrupts a page that never becomes ready", () =>
  withYuantaShell(async (page) => {
    const controller = new AbortController();
    const site = yuantaEbankSite(page, context(controller.signal));
    const opening = site.open({ path: "never", description: "never", ready: attached("#never") });
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(opening, (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
  }));

test("a date range is picked from the visible duration links, and a custom range fills its dates", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(DEPOSIT);
    await site.chooseDuration(scope, { label: "一週" });
    await site.chooseDuration(scope, { customLabel: "自訂", startDate: "2026/01/01", endDate: "2026/03/31" });
    assert.deepEqual(await scope.evaluate(() => (window as { picked?: unknown }).picked), ["一週", "自訂"]);
    assert.equal(await scope.locator("#sdate").inputValue(), "2026/01/01");
    assert.equal(await scope.locator("#edate").inputValue(), "2026/03/31");
  }));

test("an HTML response decodes as strict UTF-8, and malformed bytes fail the read", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const fmain = await site.frames.frame("fmain");
    const good = await fmain.goto(yuantaRouteUrl("summary", CID));
    assert.ok(good);
    assert.match(await site.readHtml(good), /帳戶總覽/u);
    const bad = await fmain.goto(`${YUANTA_EBANK_ORIGIN}/nib/tx/bad.html`);
    assert.ok(bad);
    await assert.rejects(site.readHtml(bad), SourceTextIntegrityError);
  }));

test("a CSV export link is fetched in the page and decoded as Big5", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(DEPOSIT);
    const download = await site.readCsv(scope.locator("#csv"));
    assert.equal(download.content, "帳號,1\r\n");
    assert.equal(download.byteLength, BIG5_ACCOUNT_HEADER.byteLength + 4);
    assert.equal(download.contentDisposition, "attachment; filename=deposit.csv");
  }));
