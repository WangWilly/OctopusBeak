import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser, type Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { classifyFailure } from "../lib/automation/failure-classification.ts";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { ProviderResponseCheckError } from "../lib/automation/provider-response-check.ts";
import { sinopacCardTransport } from "./sinopac-credit-card.ts";
import {
  readSinopacCurrentDepositBalanceResponse,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
} from "./sinopac-current-deposit-balances.ts";
import { SINOPAC_MMA_ORIGIN, sinopacMmaSite } from "./sinopac-mma-site.ts";
import { providerResponseReader, WITHOUT_PRODUCT_VALIDATION } from "./provider-response-reader.ts";
import { sinopacDepositSource } from "./sinopac-statements.ts";

const CANCELLED = new Error("synthetic cancellation");
const HOME = `${SINOPAC_MMA_ORIGIN}/mma/home.aspx`;
const ACCOUNT_ENDPOINT = "/ws/bank/transdetail/ws_debitacct.ashx";
const PROVIDER_DATE = "Wed, 09 Sep 2026 02:01:02 GMT";
const ACCOUNTS = [{ Header: "SUCCESS", SubInfo: [{ DataText: "活期存款 0012", DataValue: "0012", DisplayText: "TWD" }] }];
const BALANCES = [{ Header: "SUCCESS", SubInfo: [{ AcctValue: "0012" }] }];
const TRANSACTION_ENDPOINT = "/ws/bank/transdetail/ws_transdetailMerge.ashx";
const TRANSACTIONS = [{ Header: "FAIL", Message: "查無資料" }];
/** Bytes that are not UTF-8, inside an otherwise well-formed JSON reply. */
const MALFORMED = Buffer.concat([Buffer.from('[{"Header":"SUCCESS","Message":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]')]);

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

type Received = { method: string; path: string; headers: Record<string, string>; body: string | null };

// MMA's own replies are no-store, but Chromium never serves a fulfilled no-store body back to Playwright.
const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  headers: { date: PROVIDER_DATE },
  body: JSON.stringify(body),
});

// Each page requests its web service as MMA's own pages do: as soon as its script runs.
const requesting = (path: string, then = "") => `<!doctype html><script>
  fetch(${JSON.stringify(path)}, { method: "POST", body: "" }).then(() => { ${then} });
</script>`;

async function withMma(
  body: (page: Page, received: Received[]) => Promise<void>,
  options: Readonly<{ transactionStatus?: number }> = {},
): Promise<void> {
  const page = await browser.newPage();
  const received: Received[] = [];
  try {
    await page.route(`${SINOPAC_MMA_ORIGIN}/**`, (route) => {
      const request = route.request();
      const url = new URL(request.url());
      received.push({ method: request.method(), path: url.pathname, headers: request.headers(), body: request.postData() });
      const html = (markup: string) => void route.fulfill({ contentType: "text/html; charset=utf-8", body: markup });
      switch (url.pathname) {
        case "/mma/home.aspx":
          return html(`<a title="往來明細" href="javascript:void 0" onclick="window.detailClicked = true">往來明細</a>`);
        case "/mma/bank/transdetail/mma_transdetail.aspx":
          return html(requesting(ACCOUNT_ENDPOINT, `
            setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<input id="StartDate" />'), 300);`));
        case "/mma/bank/bankbal/mma_bankbal.aspx":
          return html(requesting(`${SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?1788926105087`));
        case "/mma/never.aspx":
          return html(`<p>載入中</p>`);
        case ACCOUNT_ENDPOINT:
          return void route.fulfill(json(ACCOUNTS));
        case TRANSACTION_ENDPOINT:
          return void route.fulfill(options.transactionStatus === undefined
            ? json(TRANSACTIONS)
            : { status: options.transactionStatus, contentType: "text/html; charset=utf-8", body: MALFORMED });
        case SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH:
          return void route.fulfill(json(BALANCES));
        case "/ws/echo.ashx":
          return void route.fulfill(json([{ Header: "SUCCESS", Message: "查詢成功" }]));
        case "/ws/card/cardqry/ws_cardsum.ashx":
          return void route.fulfill({
            status: 200,
            contentType: "application/json; charset=utf-8",
            body: MALFORMED,
          });
        default:
          return html(`<p>${url.pathname}</p>`);
      }
    });
    await page.goto(HOME, { waitUntil: "load" });
    await body(page, received);
  } finally {
    await page.close();
  }
}

const context = (signal = new AbortController().signal) =>
  ({ signal, text: strictSourceText, now: () => "2026-09-09T10:01:02+08:00" });

const reader = providerResponseReader({ ...context(), validate: WITHOUT_PRODUCT_VALIDATION });

const product = {
  event: async () => undefined,
  validate: async (check: () => unknown) => await check(),
} as unknown as ProductCollectionHandle;

test("the transaction route opens by goto from another signed-in page and reads the account list its load requests", () =>
  withMma(async (page, received) => {
    const site = sinopacMmaSite(page, context());
    const accounts = await sinopacDepositSource(site, context() as unknown as WorkflowContext, product).listAccounts();
    assert.deepEqual(accounts, ACCOUNTS[0]!.SubInfo);
    assert.equal(new URL(page.url()).pathname, "/mma/bank/transdetail/mma_transdetail.aspx");
    assert.equal(await page.locator("#StartDate").count(), 1, "the route waited for its form");
    assert.ok(received.some((request) => request.path === ACCOUNT_ENDPOINT));
    assert.equal(await page.evaluate(() => (window as unknown as { detailClicked?: boolean }).detailClicked), undefined,
      "the route never clicks the link the signed-in page shows");
  }));

test("the transaction query posts the selected account and window to ws_transdetailMerge and reads its envelope", () =>
  withMma(async (page, received) => {
    const site = sinopacMmaSite(page, context());
    const source = sinopacDepositSource(site, context() as unknown as WorkflowContext, product);
    const [account] = await source.listAccounts();
    const reply = await source.queryTransactions(account!, { startDate: "2026/08/01", endDate: "2026/08/31" }, "2026/09/09");
    assert.deepEqual(reply, TRANSACTIONS[0]);
    const sent = received.at(-1)!;
    assert.equal(sent.path, TRANSACTION_ENDPOINT);
    const form = new URLSearchParams(sent.body ?? "");
    assert.equal(form.get("AcctValue"), "0012");
    assert.equal(form.get("Curr"), "TWD");
    assert.equal(form.get("StartDate"), "2026/08/01");
    assert.equal(form.get("EndDate"), "2026/08/31");
    assert.equal(form.get("BusinessDate"), "2026/09/09");
  }));

test("a transaction reply that is not a 200 JSON reply is refused before its body is decoded", () =>
  withMma(async (page) => {
    const site = sinopacMmaSite(page, context());
    const source = sinopacDepositSource(site, context() as unknown as WorkflowContext, product);
    const [account] = await source.listAccounts();
    const error = await source.queryTransactions(account!, { startDate: "2026/08/01", endDate: "2026/08/31" }, "2026/09/09")
      .then(() => assert.fail("the error page was read"), (rejection: unknown) => rejection);
    assert.ok(!(error instanceof SourceTextIntegrityError), "the malformed body was decoded before the status was checked");
    assert.ok(error instanceof ProviderResponseCheckError && error.check === "response-status", String(error));
  }, { transactionStatus: 500 }));

// ws_bankbal's declaration requires no-store, which a synthetic reply cannot carry (see
// `json`), so the reader refuses the reply before reading its body; the account-list
// route covers a body the site reads.
test("the balance route waits for its ws_bankbal POST and checks the transport before the body", () =>
  withMma(async (page) => {
    const site = sinopacMmaSite(page, context());
    await assert.rejects(
      readSinopacCurrentDepositBalanceResponse(site, reader),
      (error: unknown) => error instanceof ProviderResponseCheckError && error.check === "response-cache-control",
    );
    assert.equal(new URL(page.url()).pathname, "/mma/bank/bankbal/mma_bankbal.aspx");
  }));

test("post sends MMA's form XHR by default, or the caller's headers, and returns the response it observed", () =>
  withMma(async (page, received) => {
    const site = sinopacMmaSite(page, context());
    const form = await site.post("/ws/echo.ashx?1", { body: "AcctValue=0012" });
    assert.deepEqual(JSON.parse(Buffer.from(form.bytes).toString("utf8")), [{ Header: "SUCCESS", Message: "查詢成功" }]);
    assert.equal(form.response.method, "POST");
    assert.equal(form.response.status, 200);
    assert.equal(form.response.url, `${SINOPAC_MMA_ORIGIN}/ws/echo.ashx?1`);
    assert.equal(form.response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(form.response.headers.date, PROVIDER_DATE);
    const sent = received.at(-1)!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.body, "AcctValue=0012");
    assert.equal(sent.headers["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
    assert.equal(sent.headers["x-requested-with"], "XMLHttpRequest");

    await site.post("/ws/echo.ashx", { headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(received.at(-1)!.headers["content-type"], "application/json");
    assert.equal(received.at(-1)!.headers["x-requested-with"], undefined);
  }));

test("a reply with invalid UTF-8 fails the product as source-integrity-failed", () =>
  withMma(async (page) => {
    const site = sinopacMmaSite(page, context());
    const error = await sinopacCardTransport(site, reader).mma("/ws/card/cardqry/ws_cardsum.ashx").then(
      () => assert.fail("the malformed reply was read"),
      (rejection: unknown) => rejection,
    );
    assert.ok(error instanceof SourceTextIntegrityError);
    assert.equal(classifyFailure({ error, events: [], stopped: false }), "source-integrity-failed");
  }));

test("a page off the MMA origin refuses to post and sends nothing", () =>
  withMma(async (page, received) => {
    await page.route("https://elsewhere.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>elsewhere</p>" }));
    await page.goto("https://elsewhere.example/", { waitUntil: "load" });
    const before = received.length;
    const site = sinopacMmaSite(page, context());
    await assert.rejects(site.post("/ws/echo.ashx"), (error: unknown) => error instanceof FailureCodeError);
    assert.equal(received.length, before);
  }));

test("cancelling the run interrupts a route whose page never requests its response", () =>
  withMma(async (page) => {
    const controller = new AbortController();
    const site = sinopacMmaSite(page, context(controller.signal));
    const opening = site.open({
      url: `${SINOPAC_MMA_ORIGIN}/mma/never.aspx`,
      description: "a page that never loads",
      response: {
        label: "never",
        host: new URL(SINOPAC_MMA_ORIGIN).hostname,
        endpoints: [{ path: "/ws/never.ashx", method: "POST" }],
        cacheControl: [],
        providerDate: "optional",
      },
      ready: async (scope) => (await scope.locator("#never").count()) > 0,
    }, providerResponseReader({ ...context(controller.signal), validate: WITHOUT_PRODUCT_VALIDATION }));
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(opening, (error: unknown) => error === CANCELLED);
    assert.ok(Date.now() - started < 2_000);
  }));
