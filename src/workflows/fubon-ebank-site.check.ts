import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import { FUBON_EBANK_ENTRY_URL, fubonEbankSite, type FubonRoute } from "./fubon-ebank-site.ts";
import type { BrowserScope } from "./frame-scope.ts";

const ORIGIN = new URL(FUBON_EBANK_ENTRY_URL).origin;
const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

type Counters = { menuOpens?: number; retryClicks?: number };

const HEADER = `<a id="menu_CLN" href="javascript:void(0)" onclick="openLoanMenu()">貸款服務</a><div id="cln"></div>
<script>
  function openLoanMenu() {
    parent.menuOpens = (parent.menuOpens ?? 0) + 1;
    document.getElementById("cln").innerHTML =
      '<a class="task_CLNQU001 menu_CLN02" href="javascript:void(0)" onclick="parent.frames.txnFrame.location.href=\\'/B2C/loan.faces\\'">貸款交易明細查詢</a>';
  }
</script>`;

async function withFubonShell(
  body: (page: Page, posted: string[], requested: string[]) => Promise<void>,
  options: Readonly<{ shell?: "frameset" | "signed-out" }> = {},
): Promise<void> {
  const page = await browser.newPage();
  const posted: string[] = [];
  const requested: string[] = [];
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      requested.push(pathname);
      const html = (body: string) => route.fulfill({ contentType: "text/html; charset=utf-8", body });
      if (request.method() === "POST") {
        posted.push(`${pathname} ${request.postData() ?? ""}`);
        if (request.postData()?.includes("broken=1")) {
          return await route.fulfill({ contentType: "text/html", body: Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0x28]) });
        }
        return await html(`<table id="result"><tr><td>交易日期</td></tr></table>`);
      }
      switch (pathname) {
        case "/B2C/common/Index.faces":
          return await html(options.shell === "signed-out"
            ? `<p>請登入</p>`
            : `<iframe name="frame1" src="/B2C/header.faces"></iframe><iframe name="txnFrame" src="/B2C/home.faces"></iframe>`);
        case "/B2C/header.faces":
          return await html(HEADER);
        case "/B2C/home.faces":
          return await html(`<a href="/B2C/deposit.faces">我的存款</a>
            <a class="task_RETRY" href="javascript:void(0)"
              onclick="parent.retryClicks = (parent.retryClicks ?? 0) + 1; if (parent.retryClicks >= 2) location.href = '/B2C/retry.faces';">重試任務</a>
            <a class="task_HANDOFF" href="/B2C/direct.faces"
              onclick="event.preventDefault(); location.href = '/B2C/handoff.faces';">交接任務</a>`);
        case "/B2C/deposit.faces":
          return await html(`<div class="_mask" style="position:fixed;inset:0">處理中</div>
            <a class="input_sel fastFunctionLinks">帳戶</a>
            <script>setTimeout(() => document.querySelector("._mask").remove(), 400);</script>`);
        case "/B2C/loan.faces":
          return await html(`<form id="form1" method="post" action="/B2C/loan.faces"><input name="acct" value="0012" /></form>`);
        case "/B2C/retry.faces":
          return await html(`<div id="retried">完成</div>`);
        case "/B2C/handoff.faces":
          return await html(`<div id="handed-off">完成</div>`);
        default:
          return await html(`<p>${pathname}</p>`);
      }
    });
    await page.goto(FUBON_EBANK_ENTRY_URL, { waitUntil: "load" });
    await body(page, posted, requested);
  } finally {
    await page.close();
  }
}

const context = (signal = new AbortController().signal) => ({ signal, text: strictSourceText });
const attached = (selector: string) => async (scope: BrowserScope) =>
  (await scope.locator(selector).count().catch(() => 0)) > 0;
const counters = (page: Page) => page.evaluate((): Counters => {
  const { menuOpens, retryClicks } = window as unknown as Counters;
  return { menuOpens, retryClicks };
});

const DEPOSITS: FubonRoute = {
  description: "my deposits page",
  link: (scope) => scope.locator("a").filter({ hasText: "我的存款" }),
  ready: attached("a.input_sel.fastFunctionLinks"),
};
const LOAN: FubonRoute = {
  description: "loan statements form",
  link: (scope) => scope.locator("a.task_CLNQU001.menu_CLN02").or(scope.locator("a").filter({ hasText: "貸款交易明細查詢" })),
  menu: "#menu_CLN",
  ready: attached("form#form1"),
};

test("a task link already on the page is followed by its href without opening a menu", () =>
  withFubonShell(async (page) => {
    const site = fubonEbankSite(page, context());
    const scope = await site.open(DEPOSITS);
    assert.ok("name" in scope && scope.name() === "txnFrame");
    assert.equal((await counters(page)).menuOpens, undefined);
    await site.waitForMaskToClear();
    assert.equal(await scope.locator("._mask").count(), 0);
  }));

test("a task link that only a header menu reveals is reached through that menu", () =>
  withFubonShell(async (page) => {
    const site = fubonEbankSite(page, context());
    const scope = await site.open(LOAN);
    assert.equal(await scope.locator("form#form1").count(), 1);
    assert.equal((await counters(page)).menuOpens, 1);
  }));

test("a task that does not render after its first trigger is triggered once more", () =>
  withFubonShell(async (page) => {
    const site = fubonEbankSite(page, context());
    const scope = await site.open({
      description: "retried task",
      link: (candidate) => candidate.locator("a.task_RETRY"),
      ready: attached("#retried"),
    });
    assert.equal(await scope.locator("#retried").count(), 1);
    assert.equal((await counters(page)).retryClicks, 2);
  }));

test("a route clicked in place lets the bank redirect instead of following the link's href", () =>
  withFubonShell(async (page, _posted, requested) => {
    const site = fubonEbankSite(page, context());
    const scope = await site.open({
      description: "handed-off task",
      link: (candidate) => candidate.locator("a.task_HANDOFF"),
      clickInPlace: true,
      ready: attached("#handed-off"),
    });
    assert.equal(await scope.locator("#handed-off").count(), 1);
    assert.ok(!requested.includes("/B2C/direct.faces"), "the link's href is never navigated to directly");
  }));

test("a page without the header frame fails as a lost session", () =>
  withFubonShell(async (page) => {
    await assert.rejects(
      fubonEbankSite(page, context()).open(DEPOSITS),
      (error: unknown) => error instanceof ProductCollectionFatalError && error.errorCode === "authentication-failed",
    );
  }, { shell: "signed-out" }));

test("cancelling the run interrupts a task that never renders", () =>
  withFubonShell(async (page) => {
    const controller = new AbortController();
    const site = fubonEbankSite(page, context(controller.signal));
    const opening = site.open({ description: "never", link: (scope) => scope.locator("a.task_RETRY"), ready: attached("#never") });
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(opening, (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
  }));

test("a form postback decodes its reply as strict UTF-8, and malformed bytes fail the read", () =>
  withFubonShell(async (page, posted) => {
    const site = fubonEbankSite(page, context());
    const scope = await site.open(LOAN);
    const form = scope.locator("form#form1");
    const html = await site.postback(form, "query", { page: "2" });
    assert.match(html, /交易日期/u);
    assert.deepEqual(posted, ["/B2C/loan.faces acct=0012&query=query&page=2"]);
    await site.replaceDocument(scope, html);
    assert.equal(await scope.locator("#result").count(), 1);

    const reloaded = await site.open(LOAN);
    await assert.rejects(site.postback(reloaded.locator("form#form1"), undefined, { broken: "1" }), SourceTextIntegrityError);
  }));
