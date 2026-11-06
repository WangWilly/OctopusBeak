import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { classifyFailure, type FailureEvidenceEvent } from "../lib/automation/failure-classification.ts";
import { validationReporter } from "../lib/automation/product-collection.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import type { BrowserScope } from "./frame-scope.ts";
import { acceptProviderResponse, type ProviderResponseDeclaration } from "./provider-response.ts";
import {
  YUANTA_EBANK_ORIGIN,
  yuantaCsvExportResponse,
  yuantaEbankSite,
  yuantaRouteUrl,
  type YuantaRoute,
} from "./yuanta-ebank-site.ts";

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
        case "/nib/tx/failing.csv":
          return void route.fulfill({ status: 500, contentType: "text/csv", body: "error" });
        case "/nib/tx/utf8.csv":
          return void route.fulfill({
            contentType: "text/csv; charset=utf-8",
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

test("cancelling the run stops a pending date fill instead of letting it fill once the field appears", () =>
  withYuantaShell(async (page) => {
    const controller = new AbortController();
    const site = yuantaEbankSite(page, context(controller.signal));
    const scope = await site.open(DEPOSIT);
    await scope.evaluate(() => {
      const field = document.querySelector("#sdate")!;
      field.remove();
      setTimeout(() => document.querySelector("form")!.append(field), 400);
    });
    setTimeout(() => controller.abort(CANCELLED), 100);
    const choosing = site.chooseDuration(scope, { customLabel: "自訂", startDate: "2026/01/01", endDate: "2026/03/31" });
    await assert.rejects(choosing, (error: unknown) => error === CANCELLED);
    await scope.locator("#sdate").waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    assert.equal(await scope.locator("#sdate").inputValue(), "", "the cancelled fill never ran");
  }));

const HTML_PAGES: ProviderResponseDeclaration = {
  label: "Yuanta synthetic page",
  host: new URL(YUANTA_EBANK_ORIGIN).hostname,
  endpoints: [
    { path: "/nib/tx/summary", method: "GET", search: /^\?type=page&cid=[^&]+$/u, charset: { decode: "utf-8" } },
    { path: "/nib/tx/bad.html", method: "GET", charset: { decode: "utf-8" } },
  ],
  cacheControl: [],
  providerDate: "optional",
};
const OBSERVED_AT = "2026-09-10T10:03:04+08:00";

test("an HTML response is verified against its declaration inside validation and decodes strictly, and malformed bytes fail the read", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const rejectedInValidation: unknown[] = [];
    const acceptance = {
      observedAt: OBSERVED_AT,
      validate: async <T>(check: () => T | Promise<T>): Promise<T> => {
        try {
          return await check();
        } catch (error) {
          rejectedInValidation.push(error);
          throw error;
        }
      },
    };
    const fmain = await site.frames.frame("fmain");
    const good = await fmain.goto(yuantaRouteUrl("summary", CID));
    assert.ok(good);
    assert.match(await site.readHtml(HTML_PAGES, good, acceptance), /帳戶總覽/u);
    const refusing = site.readHtml({ ...HTML_PAGES, endpoints: HTML_PAGES.endpoints.slice(1) }, good, acceptance);
    await assert.rejects(
      refusing,
      (error) => error instanceof ProviderResponseCheckError && error.check === "response-endpoint",
      "a response from an endpoint the declaration does not name is refused",
    );
    assert.equal(rejectedInValidation.length, 1, "the endpoint refusal is thrown inside the product's validation");
    const bad = await fmain.goto(`${YUANTA_EBANK_ORIGIN}/nib/tx/bad.html`);
    assert.ok(bad);
    await assert.rejects(site.readHtml(HTML_PAGES, bad, acceptance), SourceTextIntegrityError);
  }));

test("a CSV export link is fetched in the page and decoded as Big5", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(DEPOSIT);
    const download = await site.readCsv(scope.locator("#csv"), { observedAt: OBSERVED_AT, validate: async (check) => await check() });
    assert.equal(download.content, "帳號,1\r\n");
    assert.equal(download.byteLength, BIG5_ACCOUNT_HEADER.byteLength + 4);
    assert.equal(download.contentDisposition, "attachment; filename=deposit.csv");
  }));

test("a CSV reply that is not 200, or names another charset, fails the product's validation with its named check", () =>
  withYuantaShell(async (page) => {
    const site = yuantaEbankSite(page, context());
    const scope = await site.open(DEPOSIT);
    const link = scope.locator("#csv");
    const failedAs = async (href: string) => {
      await link.evaluate((anchor, value) => anchor.setAttribute("href", value), href);
      const events: FailureEvidenceEvent[] = [];
      const validate = validationReporter(async (stage, outcome) => {
        events.push({ stage, outcome });
      }, new AbortController().signal);
      const error = await site.readCsv(link, { observedAt: OBSERVED_AT, validate }).then(
        () => assert.fail("the CSV read must fail"),
        (thrown: unknown) => thrown,
      );
      return { error, code: classifyFailure({ error, events, stopped: false }) };
    };

    const failing = await failedAs("/nib/tx/failing.csv");
    assert.ok(failing.error instanceof ProviderResponseCheckError && failing.error.check === "response-status");
    assert.equal(failing.code, "source-validation-failed", "the status check fails inside the product's validation");

    const utf8 = await failedAs("/nib/tx/utf8.csv");
    assert.ok(utf8.error instanceof ProviderResponseCheckError && utf8.error.check === "response-charset");
    assert.equal(utf8.code, "source-validation-failed");
  }));

// A fulfilled 302 under page routing is followed on the real network, so redirect acceptance is checked on the declaration.
test("a CSV reply that a same-origin redirect moved is accepted where it landed, on the eBank host only", () => {
  const reply = (url: string) => acceptProviderResponse(
    yuantaCsvExportResponse({ url, method: "GET" }),
    {
      evidence: { kind: "text", bytes: Buffer.concat([BIG5_ACCOUNT_HEADER, Buffer.from(",1\r\n")]) },
      response: { url, status: 200, method: "GET", headers: { "content-type": "text/csv" } },
    },
    { observedAt: OBSERVED_AT, text: strictSourceText },
  );
  assert.equal(reply(`${YUANTA_EBANK_ORIGIN}/nib/tx/export.csv?after=redirect`).evidence.text, "帳號,1\r\n");
  for (const url of ["http://ebank.yuantabank.com.tw/nib/tx/export.csv", "https://elsewhere.example/nib/tx/export.csv"])
    assert.throws(() => reply(url), (error) => error instanceof ProviderResponseCheckError && error.check === "response-endpoint", url);
});
