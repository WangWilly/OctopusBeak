import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { einvoicePersonalInvoicesWorkflow } from "./einvoice-workflow.ts";
import { strictSourceText } from "./source-text.ts";
import type { WorkflowContext, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import {
  assertEinvoiceCaptureAdmissible,
  buildCanonicalEInvoiceCapture,
  einvoiceCaptchaAssistanceStage,
  requestEinvoiceCaptchaAssistance,
} from "../../workflows/einvoice-personal-invoices.ts";
import type { HumanAssistanceContractInput } from "./human-assistance.ts";

const loginUrl = "https://www.einvoice.nat.gov.tw/accounts/login";
const homeUrl = "https://www.einvoice.nat.gov.tw/portal/btc/mobile/home";
const listEndpoint = "https://www.einvoice.nat.gov.tw/btc/cloud/api/btc502w/searchCarrierInvoice";
const credentials = {
  einvoice_phone_number: "0900000000",
  einvoice_password: "test-only-secret",
};

const searchPage = () => `<!doctype html>
<html><body>
  <input id="dp-input-searchInvoiceDate" />
  <div class="dp__month_year_wrap"></div>
  <button aria-label="上個月" type="button">prev</button>
  <button aria-label="下個月" type="button">next</button>
  <div id="days"></div>
  <select id="carrier"><option value="all">All</option></select>
  <select id="status"><option value="all">All</option></select>
  <input id="buyerBan" /><input id="productName" />
  <button aria-label="查詢" type="button">查詢</button>
  <script>
    let month = new Date().getMonth();
    let year = new Date().getFullYear();
    const label = document.querySelector('.dp__month_year_wrap');
    const render = () => {
      label.textContent = (month + 1) + '月 ' + year + '年';
      document.querySelector('#days').innerHTML = Array.from({ length: 31 }, (_, i) =>
        '<div class="dp__calendar_item"><span class="dp__cell_inner">' + (i + 1) + '</span></div>'
      ).join('');
    };
    document.querySelector('[aria-label="上個月"]').addEventListener('click', () => {
      month -= 1; if (month < 0) { month = 11; year -= 1; } render();
    });
    document.querySelector('[aria-label="下個月"]').addEventListener('click', () => {
      month += 1; if (month > 11) { month = 0; year += 1; } render();
    });
    document.querySelector('[aria-label="查詢"]').addEventListener('click', () => {
      fetch('/btc/cloud/api/btc502w/searchCarrierInvoice', { method: 'POST' });
    });
    render();
  </script>
</body></html>`;

const loginPage = `<!doctype html>
<html><body>
  <input id="mobile_phone" /><input id="password" /><input id="captcha" />
  <span class="input-group-text code_num"><img alt="圖形驗證碼" width="150" height="40"
    src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" /></span>
  <button id="submitBtn" type="button" onclick="location.href='/portal/btc/mobile/home'">登入</button>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  let malformedList = false;
  await page.route("https://www.einvoice.nat.gov.tw/**", async (route) => {
    const url = route.request().url();
    if (url === loginUrl) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: loginPage });
      return;
    }
    if (url === homeUrl) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html><body>會員專區</body></html>" });
      return;
    }
    if (url.includes("/portal/btc/mobile/btc502w/search")) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: searchPage() });
      return;
    }
    if (url.includes("/btc/cloud/api/btc502w/searchCarrierInvoice")) {
      if (malformedList) {
        await route.fulfill({ status: 200, contentType: "application/json", body: Buffer.from([0xff, 0x80]) });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({ totalElements: 0, totalPages: 0, size: 0, content: [] }),
        });
      }
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html></html>" });
  });

  const opened = page;
  await opened.goto(loginUrl);

  const events: Array<{ stage: string; code: string; completed?: number; total?: number }> = [];
  const commits: unknown[] = [];
  const contractIds: string[] = [];
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      commits.push(...received);
      const capture = (received[0]?.command as unknown as { request: { captureId: string; invoices: unknown[] } }).request;
      const value = {
        status: "committed",
        captureId: capture.captureId,
        knowledgeAt: 1,
        sourceRecordIds: [],
        invoiceCount: capture.invoices.length,
        insertedInvoiceCount: capture.invoices.length,
        insertedRevisionCount: capture.invoices.length,
        observedDuplicateCount: 0,
        itemCount: 0,
      };
      return {
        status: "completed",
        items: [{ itemKey: "einvoice-test", provider: "einvoice", product: "personal-invoice", status: "committed", admissionSummaries: [], value, relationWarnings: [] }],
        diagnostics: [],
        committedCount: 1,
        failedCount: 0,
      };
    },
  };

  const context: WorkflowContext = {
    runId: "einvoice-test-run",
    signal: new AbortController().signal,
    now: () => new Date().toISOString(),
    browser: { withPage: async (run) => await run(opened as Page) },
    text: strictSourceText,
    humanAssistance: {
      async request(contract: HumanAssistanceContractInput) {
        contractIds.push(contract.stageId);
        await opened.locator("#captcha").fill("12345");
        return "entered";
      },
    },
    financialCommit,
    async event(stage, code, counts) {
      events.push({ stage, code, ...counts });
    },
  };

  await opened.goto(loginUrl);
  const output = await einvoicePersonalInvoicesWorkflow.run(context, { credentials });
  assert.equal(output.usedExistingSession, false);
  assert.equal(output.invoiceCount, 0);
  assert.deepEqual(contractIds, ["einvoice-login-captcha"]);
  assert.ok(events.some((event) => event.code === "authentication-completed"));
  assert.ok(events.some((event) => event.code === "month-completed" && event.total && event.total > 1));
  assert.ok(events.some((event) => event.code === "canonical-commit-completed"));
  assert.equal(commits.length, 1);

  malformedList = true;
  const badPage = await browser.newPage();
  await badPage.route("https://www.einvoice.nat.gov.tw/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/portal/btc/mobile/btc502w/search")) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: searchPage() });
      return;
    }
    if (url.includes("/btc/cloud/api/btc502w/searchCarrierInvoice")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: Buffer.from([0xff, 0x80]) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html><body>會員專區</body></html>" });
  });
  await badPage.goto(homeUrl);
  const malformedContext: WorkflowContext = {
    ...context,
    runId: "einvoice-malformed-run",
    browser: { withPage: async (run) => await run(badPage) },
    humanAssistance: { async request() { throw new Error("Unexpected human assistance request"); } },
  };
  await assert.rejects(
    einvoicePersonalInvoicesWorkflow.run(malformedContext, { credentials }),
    /Source text integrity failed: invalid-encoding/u,
  );
  assert.equal(commits.length, 1, "malformed source must be rejected before Canonical Financial Commit");

  const incompleteCapture = buildCanonicalEInvoiceCapture({
    records: [{
      month: { year: 2026, month: 9 },
      listPageIndex: 0,
      entry: { token: "row", invoiceNumber: "AA00000001", invoiceStrStatus: "INVOICE0003S" },
      header: { invoiceDate: "20260910", sellerId: "11112222", totalAmount: "10" },
      items: [{ item: "item", quantity: "1", unitPrice: null, amount: "10" }],
      itemCompleteness: "incomplete",
    }],
    pages: [{
      month: { year: 2026, month: 9 },
      pageIndex: 0,
      list: { httpStatus: 200, totalElements: 1, totalPages: 1, size: 1, content: [] },
    }],
    months: ["2026-09"],
  }, credentials, { captureId: "incomplete-capture" });
  assert.throws(() => assertEinvoiceCaptureAdmissible(incompleteCapture), /source is incomplete/u);

  const aborted = new AbortController();
  aborted.abort();
  let acquiredPage = false;
  await assert.rejects(einvoicePersonalInvoicesWorkflow.run({
    ...context,
    signal: aborted.signal,
    browser: { async withPage() { acquiredPage = true; throw new Error("Page should not be opened"); } },
  }, { credentials }), /AbortError|aborted/u);
  assert.equal(acquiredPage, false, "cancelled run must stop before accessing the provider page");

  await opened.setContent(loginPage);
  await assert.rejects(requestEinvoiceCaptchaAssistance(
    einvoiceCaptchaAssistanceStage(opened as Page),
    async () => "failed",
    new AbortController().signal,
  ), /ended with status failed/u);
} finally {
  await browser.close();
}
