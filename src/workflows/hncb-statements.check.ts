import assert from "node:assert/strict";
import { chromium, type Frame, type Page } from "playwright";
import {
  emitHumanAssistanceStage,
} from "./human-assistance.ts";
import {
  buildHncbCapture,
  buildHncbCurrentDepositBalanceCapture,
  hncbCaptchaAssistanceStage,
  ensureHncbStatementForm,
  isNoStatementDataText,
  normalizeHncbTransactionRows,
  indexHncbCurrentDepositFinancialCaptures,
  parseStatementExport,
  prepareHncbStatementQueryForm,
} from "./hncb-statements.ts";
import {
  HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  parseHncbCurrentDepositOverviewTable,
} from "./hncb-current-deposit-balances.ts";

const parsedStatement = parseStatementExport(
  `
    <html><body><table>
      <tr><td>帳號</td><td>123-456</td></tr>
      <tr><td>資料起訖日</td><td>2025/01/01-2025/01/31</td></tr>
      <tr><td>幣別</td><td>TWD</td></tr>
      <tr>
        <td>交易日期</td><td>交易時間</td><td>帳務日期</td><td>幣別</td>
        <td>支出金額</td><td>存入金額</td><td>即時餘額</td><td>摘要</td>
        <td>存款人代號</td><td>備註</td><td>補摺日期/票據號碼</td>
      </tr>
      <tr>
        <td>0114/01/02</td><td>08:30:00</td><td>0114/01/02</td><td>TWD</td>
        <td>100</td><td></td><td>900</td><td>手續費&nbsp;測試</td>
        <td></td><td>A&amp;B</td><td></td>
      </tr>
    </table></body></html>
  `,
  "fallback",
);
assert.equal(parsedStatement.account, "123-456");
assert.equal(parsedStatement.accountId, "123456");
assert.equal(parsedStatement.queryPeriod, "2025/01/01-2025/01/31");
assert.equal(parsedStatement.currency, "TWD");
assert.deepEqual(parsedStatement.rows, [
  [
    "2025/01/02",
    "08:30:00",
    "2025/01/02",
    "TWD",
    "100",
    "",
    "900",
    "手續費 測試",
    "",
    "A&B",
    "",
  ],
]);

const workflowCapture = buildHncbCapture(
  { value: "001234567890", label: "HNCB 001234567890" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
  {
    account: "001234-567890",
    accountId: "001234567890",
    queryPeriod: "2026/08/01-2026/08/31",
    currency: "TWD",
    rows: [],
    filename: "hncb.xls",
    byteLength: 1,
    contentDigest: "sha256:workflow-capture",
  },
);
assert.deepEqual(workflowCapture.account.accountNumber, {
  value: "001234567890",
  kind: "depository-account",
  evidenceVersion: "hncb/domestic-deposit/account-number-v1",
  sourceField: "select#acct1 option.value + workbook metadata 帳號",
});
const noDataSelectorCapture = buildHncbCapture(
  { value: "012345678901", label: "012345678901" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
);
assert.deepEqual(noDataSelectorCapture.account.accountNumber, {
  value: "012345678901",
  kind: "depository-account",
  evidenceVersion: "hncb/domestic-deposit/account-number-v2",
  sourceField: "select#acct1 option.value + option.text",
});
const opaqueWorkflowCapture = buildHncbCapture(
  { value: "sha256:opaque-selector", label: "HNCB account" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
  {
    account: "001234567890",
    accountId: "001234567890",
    queryPeriod: "2026/08/01-2026/08/31",
    currency: "TWD",
    rows: [],
    filename: "hncb.xls",
    byteLength: 1,
    contentDigest: "sha256:workflow-capture-opaque",
  },
);
assert.equal(opaqueWorkflowCapture.account.accountNumber, undefined);
const hncbCurrentCapture = buildHncbCurrentDepositBalanceCapture(
  {
    source: "hncb",
    accountNumber: "001234567890",
    currency: "TWD",
    currencySourceLexeme: "TWD",
    available: { coefficient: "90", scale: 2, sourceLexeme: "90.00" },
    ledger: { coefficient: "100", scale: 2, sourceLexeme: "100.00" },
    effectiveAt: "2026-08-31T01:00:00.000Z",
    providerHttpDate: "Mon, 31 Aug 2026 01:00:00 GMT",
    observedAt: "2026-08-31T09:00:00+08:00",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.EAccDDSummary",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-v1",
    },
  },
  {
    identity: {
      sourceConnectionKey: "sha256:hncb-current-connection",
      identityEpochKey: "sha256:hncb-current-epoch",
      subjectDigest: "sha256:hncb-current-subject",
      accountNo: "001234567890",
      accountNumber: { value: "001234567890" },
    },
  },
);
assert.equal(hncbCurrentCapture.identity.sourceAccountKey, "001234567890");
assert.deepEqual(
  hncbCurrentCapture.observations.map((observation) => observation.sourceField),
  ["帳上餘額", "可用餘額"],
);
assert.equal(hncbCurrentCapture.records.length, 2);

const overviewCurrentRow = {
    source: "hncb",
    accountNumber: "166970072770",
    currency: "",
    currencySourceLexeme: "",
    currencyResolution: "missing",
    available: { coefficient: "0", scale: 2, sourceLexeme: "0.00" },
    ledger: { coefficient: "0", scale: 2, sourceLexeme: "0.00" },
    effectiveAt: "2026-09-09T05:57:04.000Z",
    providerHttpDate: "Wed, 09 Sep 2026 05:57:04 GMT",
    observedAt: "2026-09-09T13:57:10+08:00",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.AcctInfoInq",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-overview-v1",
      url: "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt&time_str=20260909135527",
    },
  } as const;
const overviewCurrentCapture = buildHncbCurrentDepositBalanceCapture(
  overviewCurrentRow,
  {
    identity: {
      sourceConnectionKey: "sha256:hncb-current-connection",
      identityEpochKey: "sha256:hncb-current-epoch",
      subjectDigest: "sha256:hncb-current-subject",
      accountNo: "166970072770",
      accountNumber: { value: "166970072770" },
      currency: "TWD",
    },
  },
);
assert.equal(
  overviewCurrentCapture.authorityRoute,
  "hncb/domestic-deposit/current-balance-overview-v1",
);
assert.deepEqual(
  overviewCurrentCapture.observations.map((observation) => observation.sourceField),
  ["帳上餘額", "原幣"],
);
assert.equal(overviewCurrentCapture.records[0]?.compact.currencyResolution, "canonical-account");
assert.equal(overviewCurrentCapture.records[0]?.compact.canonicalCurrency, "TWD");
assert.throws(
  () =>
    buildHncbCurrentDepositBalanceCapture(
      overviewCurrentRow,
      {
        identity: {
          sourceConnectionKey: "sha256:hncb-current-connection",
          identityEpochKey: "sha256:hncb-current-epoch",
          subjectDigest: "sha256:hncb-current-subject",
          accountNo: "166970072770",
          accountNumber: { value: "166970072770" },
        },
      },
    ),
  /cannot resolve blank currency/u,
);
const indexed = indexHncbCurrentDepositFinancialCaptures([
  {
    identity: {
      sourceConnectionKey: "same-connection",
      identityEpochKey: "same-epoch",
      subjectDigest: "same-subject",
      accountNo: "166970072770",
      accountNumber: { value: "166970072770" },
      currency: "TWD",
    },
  },
]);
assert.equal(indexed.get("166970072770")?.identity.currency, "TWD");
assert.throws(
  () => parseStatementExport("x".repeat(16 * 1024 * 1024 + 1), "fallback"),
  /16 MiB safety limit/,
);

const browserCompatibleStatement = parseStatementExport(
  `<table>
    <tr><td data-note="1 > 0">帳號<td>789-012
    <tr><td>資料起訖日<td>2025/02/01-2025/02/28
    <tr><td>幣別<td>TWD
    <tr><td>交易日期<td>交易時間<td>帳務日期<td>幣別<td>支出金額<td>存入金額<td>即時餘額<td>摘要<td>存款人代號<td>備註<td>補摺日期/票據號碼
    <tr><td>0114/02/03<td>09:00:00<td>0114/02/03<td>TWD<td><td>250<td>1250<td>入帳<td><td><td>
  </table>`,
  "fallback",
);
assert.equal(browserCompatibleStatement.account, "789-012");
assert.deepEqual(browserCompatibleStatement.rows[0]?.slice(0, 8), [
  "2025/02/03",
  "09:00:00",
  "2025/02/03",
  "TWD",
  "",
  "250",
  "1250",
  "入帳",
]);

const browser = await chromium.launch();
try {
  const overviewPage = await browser.newPage();
  await overviewPage.setContent(`
    <table id="shell"><tbody><tr><td>
      <table id="overview">
        <tr>
          <td rowspan="2">帳號</td><td rowspan="2">類別</td><td rowspan="2">幣別</td>
          <td rowspan="2">帳上餘額</td><td colspan="2">可用餘額</td>
          <td rowspan="2">薪轉利率</td><td rowspan="2">餘額查詢</td>
          <td rowspan="2">明細查詢</td><td rowspan="2">轉帳</td><td rowspan="2">其他查詢</td>
        </tr>
        <tr><td>原幣</td><td>折合新台幣</td></tr>
        <tr><td>166203735484</td><td>活儲</td><td>新台幣</td><td>11,389.00</td><td>11,389.00</td><td>-</td><td>-</td><td>餘額<table><tr><td>link</td></tr></table></td><td>明細</td><td>轉帳</td><td>其他</td></tr>
        <tr><td>166970072770</td><td>活存</td><td></td><td>0.00</td><td>0.00</td><td>-</td><td>-</td><td>餘額</td><td>明細</td><td></td><td>其他</td></tr>
        <tr><td colspan="11">查詢結果</td></tr>
        <tr><td colspan="9">&nbsp;列印&nbsp;</td></tr>
      </table>
    </td></tr></tbody></table>
  `);
  const overview = await parseHncbCurrentDepositOverviewTable(overviewPage, {
    observedAt: "2026-09-09T13:57:10+08:00",
    response: {
      url: `https://netbank.hncb.com.tw${HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH}?trx=${HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION}&state=prompt&time_str=20260909135527`,
      status: 200,
      method: "GET",
      headers: {
        date: "Wed, 09 Sep 2026 05:57:04 GMT",
        "cache-control": "no-store",
        "content-type": "text/html; charset=big5",
      },
    },
  });
  assert.equal(overview.length, 2);
  assert.equal(overview[0]?.accountNumber, "166203735484");
  assert.equal(overview[0]?.ledger.coefficient, "1138900");
  assert.equal(overview[1]?.accountNumber, "166970072770");
  assert.equal(overview[1]?.currency, "");
  assert.equal(overview[1]?.currencyResolution, "missing");
  assert.equal(overview[1]?.ledger.coefficient, "0");
  assert.equal(overview[1]?.available.coefficient, "0");
  await overviewPage.close();

  const browserPage = await browser.newPage();
  await browserPage.setContent(`
    <form name="form1" target="acct">
      <input type="hidden" name="excel_download" value="52">
    </form>
  `);

  await prepareHncbStatementQueryForm(browserPage.mainFrame());

  const form = browserPage.locator('form[name="form1"]');
  assert.equal(await form.getAttribute("target"), "_self");
  assert.equal(
    await form.locator('input[name="excel_download"]').inputValue(),
    "",
  );

  const captchaPage = await browser.newPage();
  await captchaPage.setContent(`
    <input id="TrxCaptchaKey" style="width: 92px; height: 32px" />
    <img
      id="code_Cap"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
      width="80"
      height="30"
      alt="HNCB CAPTCHA"
    />
  `);
  const captchaContract = await emitHumanAssistanceStage(
    hncbCaptchaAssistanceStage(captchaPage),
    (contract) => contract,
  );
  assert.equal(captchaContract.stageId, "hncb-login-captcha");
  assert.equal(captchaContract.challengeKind, "text-captcha");
  assert.equal(captchaContract.charset, "digits");
  assert.equal(captchaContract.ocrPageSegmentationMode, "single-word");
  assert.equal(captchaContract.solverConfidenceThreshold, 0.8);
  assert.equal(
    captchaContract.targets[0]?.semanticId,
    "hncb.login.captcha-input",
  );
  assert.equal(
    captchaContract.challengeImageRegion?.semanticId,
    "hncb.login.captcha-image",
  );
  assert.ok(captchaContract.challengeImageRegion?.rect);
  assert.equal(
    captchaContract.imagePreprocessing,
    undefined,
    "HNCB CAPTCHA must not request interference-line removal",
  );
  await captchaPage.close();
} finally {
  await browser.close();
}

assert.equal(
  isNoStatementDataText("查     無     資     料"),
  true,
  "a spaced HNCB no-data result must finish instead of timing out",
);

const normalizedRows = normalizeHncbTransactionRows([
  ["交易日期", "交易時間", "帳務日期"],
  ["0113/08/19", "12:34:56", "0113/08/20"],
  ["2025/08/19", "12:34:56", "2025/08/20"],
  ["1900/01/01", "12:34:56", "1900/01/02"],
]);
assert.deepEqual(normalizedRows.map((row) => row.slice(0, 3)), [
  ["2024/08/19", "12:34:56", "2024/08/20"],
  ["2025/08/19", "12:34:56", "2025/08/20"],
  ["1900/01/01", "12:34:56", "1900/01/02"],
]);

const page = {} as Page;
const currentFrame = {} as Frame;
const reopenedFrame = {} as Frame;

let reopened = false;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async () => currentFrame,
    async () => {
      reopened = true;
      return reopenedFrame;
    },
  ),
  currentFrame,
);
assert.equal(reopened, false);

let observedTimeout = 0;
assert.equal(
  await ensureHncbStatementForm(
    page,
    async (_page, timeoutMs) => {
      observedTimeout = timeoutMs ?? 0;
      throw new Error("statement form missing");
    },
    async () => reopenedFrame,
  ),
  reopenedFrame,
);
assert.equal(observedTimeout, 5_000);
