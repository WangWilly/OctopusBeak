import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Frame } from "playwright";
import { resolveVerificationStage } from "../lib/automation/verification-stage.ts";
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
  hncbCurrentDepositBalances,
  stageHncbDeposit,
  type HncbReadCurrentDepositBalances,
} from "./hncb-statements.ts";
import { frameScope, FrameScopeTimeoutError, type FrameScope } from "./frame-scope.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import {
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
} from "../ledger/canonical/hncb-domestic-deposit-admission.ts";
import { HNCB_HUMAN_ATTESTED_V1_MANIFEST } from "../ledger/canonical/hncb-human-attestation-contract.ts";
import {
  HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  parseHncbCurrentDepositOverviewTable,
} from "./hncb-current-deposit-balances.ts";

const providerSource = readFileSync(new URL("./hncb-statements.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  providerSource,
  /from\s+["']libretto["']|librettoAuthenticate|export\s+default\s+workflow\s*\(|\bpause\(/u,
  "HNCB production must use the App-owned typed workflow only",
);
assert.doesNotMatch(
  providerSource,
  /node:fs\/promises|writeStatementFile|outputDir|downloads\/hncb-statements|csvFilename|jsonFilename/u,
  "HNCB production must not generate statement files",
);
assert.doesNotMatch(
  providerSource,
  /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u,
  "HNCB must commit through the injected Canonical Financial Commit port",
);
assert.doesNotMatch(
  providerSource,
  /console\./u,
  "HNCB production must report progress through structured events",
);

const accountA = ["0001", "0002", "0003"].join("");
const accountB = ["0002", "0003", "0004"].join("");
const overviewAccountA = ["0003", "0004", "0005"].join("");
const overviewAccountB = ["0004", "0005", "0006"].join("");

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
const splitMetadataStatement = parseStatementExport(`
  <table><tr><td>華南銀行交易明細</td></tr></table>
  <table><tr><td>帳號</td><td>123-456</td></tr><tr><td>資料起訖日</td><td>2025/01/01-2025/01/31</td></tr><tr><td>幣別</td><td>TWD</td></tr></table>
  <table><tr><td>交易日期</td><td>交易時間</td></tr></table>
`, "fallback");
assert.equal(splitMetadataStatement.account, "123-456");
assert.equal(splitMetadataStatement.queryPeriod, "2025/01/01-2025/01/31");
assert.equal(splitMetadataStatement.currency, "TWD");
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
  { value: accountA, label: `HNCB ${accountA}` },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
  {
    account: `${accountA.slice(0, 6)}-${accountA.slice(6)}`,
    accountId: accountA,
    queryPeriod: "2026/08/01-2026/08/31",
    currency: "TWD",
    rows: [],
    filename: "hncb.xls",
    byteLength: 1,
    contentDigest: "sha256:workflow-capture",
  },
);
assert.deepEqual(workflowCapture.account.accountNumber, {
  value: accountA,
  kind: "depository-account",
  evidenceVersion: "hncb/domestic-deposit/account-number-v1",
  sourceField: "select#acct1 option.value + workbook metadata 帳號",
});
const duplicateHncbRow = [
  "2026/08/02", "09:10:00", "2026/08/02", "TWD", "100", "", "900",
  "SYNTHETIC TRANSFER", "", "", "",
];
const duplicateHncbEvidence = admitHncbDomesticDepositCaptureEvidence(
  buildHncbCapture(
    { value: accountA, label: `HNCB ${accountA}` },
    { startDate: "2026/08/01", endDate: "2026/08/31" },
    "2026-08-31T12:00:00+08:00",
    {
      account: `${accountA.slice(0, 6)}-${accountA.slice(6)}`,
      accountId: accountA,
      queryPeriod: "2026/08/01-2026/08/31",
      currency: "TWD",
      rows: [duplicateHncbRow, duplicateHncbRow],
      filename: "synthetic-hncb.xls",
      byteLength: 2,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  ),
);
assert.equal(duplicateHncbEvidence.status, "admissible");
const duplicateHncbFinancial = admitHncbDomesticDepositFinancialCapture({
  capture: duplicateHncbEvidence.capture!,
  captureId: "hncb-duplicate-occurrence-check",
  humanAttestation: HNCB_HUMAN_ATTESTED_V1_MANIFEST,
});
assert.equal(duplicateHncbFinancial.status, "admitted");
assert.deepEqual(
  duplicateHncbFinancial.capture!.records.map(
    (record) => record.occurrenceGroup?.ordinal,
  ),
  [1, 2],
  "identical HNCB rows retain two semantic occurrence slots",
);
assert.equal(duplicateHncbFinancial.capture!.occurrenceGroupCoverage?.length, 1);
const noDataSelectorCapture = buildHncbCapture(
  { value: accountB, label: accountB },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
);
assert.deepEqual(noDataSelectorCapture.account.accountNumber, {
  value: accountB,
  kind: "depository-account",
  evidenceVersion: "hncb/domestic-deposit/account-number-v2",
  sourceField: "select#acct1 option.value + option.text",
});
const opaqueWorkflowCapture = buildHncbCapture(
  { value: "sha256:opaque-selector", label: "HNCB account" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
  "2026-08-31T12:00:00+08:00",
  {
    account: accountA,
    accountId: accountA,
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
    accountNumber: accountA,
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
      accountNo: accountA,
      accountNumber: { value: accountA },
    },
  },
);
assert.equal(hncbCurrentCapture.identity.sourceAccountKey, accountA);
assert.deepEqual(
  hncbCurrentCapture.observations.map((observation) => observation.sourceField),
  ["帳上餘額", "可用餘額"],
);
assert.equal(hncbCurrentCapture.records.length, 2);

const overviewCurrentRow = {
    source: "hncb",
    accountNumber: overviewAccountB,
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
      accountNo: overviewAccountB,
      accountNumber: { value: overviewAccountB },
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
          accountNo: overviewAccountB,
          accountNumber: { value: overviewAccountB },
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
      accountNo: overviewAccountB,
      accountNumber: { value: overviewAccountB },
      currency: "TWD",
    },
  },
]);
assert.equal(indexed.get(overviewAccountB)?.identity.currency, "TWD");
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
        <tr><td>${overviewAccountA}</td><td>活儲</td><td>新台幣</td><td>11,389.00</td><td>11,389.00</td><td>-</td><td>-</td><td>餘額<table><tr><td>link</td></tr></table></td><td>明細</td><td>轉帳</td><td>其他</td></tr>
        <tr><td>${overviewAccountB}</td><td>活存</td><td></td><td>0.00</td><td>0.00</td><td>-</td><td>-</td><td>餘額</td><td>明細</td><td></td><td>其他</td></tr>
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
  assert.equal(overview[0]?.accountNumber, overviewAccountA);
  assert.equal(overview[0]?.ledger.coefficient, "1138900");
  assert.equal(overview[1]?.accountNumber, overviewAccountB);
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
  const captchaContract = await resolveVerificationStage(hncbCaptchaAssistanceStage(captchaPage));
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

const scope = {} as FrameScope;
const currentFrame = {} as Frame;
const reopenedFrame = {} as Frame;

let reopened = false;
assert.equal(
  await ensureHncbStatementForm(
    scope,
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
    scope,
    async (_scope, timeoutMs) => {
      observedTimeout = timeoutMs ?? 0;
      throw new FrameScopeTimeoutError("statement form missing");
    },
    async () => reopenedFrame,
  ),
  reopenedFrame,
);
assert.equal(observedTimeout, 5_000);

const cancellation = new Error("run cancelled");
reopened = false;
await assert.rejects(
  ensureHncbStatementForm(
    scope,
    async () => { throw cancellation; },
    async () => {
      reopened = true;
      return reopenedFrame;
    },
  ),
  (error: unknown) => error === cancellation,
);
assert.equal(reopened, false, "only a timed-out form wait reopens the statement detail");

// The statement form lives in HNCB's `main` frame; the frame scope finds it
// there, and a cancelled run stops the wait with its reason instead of
// reopening the form after the 5 s probe.
const formBrowser = await chromium.launch();
try {
  const formPage = await formBrowser.newPage();
  await formPage.setContent(`<iframe name="main" srcdoc="
    <form name='form1'><select id='acct1' name='acct1'><option value='1'>1</option></select></form>
    <a href='javascript:doSubmit()'>查詢</a>
  "></iframe>`);
  const formFrame = await ensureHncbStatementForm(
    frameScope(formPage, new AbortController().signal),
    undefined,
    async () => { throw new Error("the present form must not be reopened"); },
  );
  assert.equal(formFrame.name(), "main");

  const emptyPage = await formBrowser.newPage();
  await emptyPage.setContent(`<iframe name="main" srcdoc="<p>帳戶總覽</p>"></iframe>`);
  const run = new AbortController();
  const started = Date.now();
  setTimeout(() => run.abort(cancellation), 100);
  await assert.rejects(
    ensureHncbStatementForm(
      frameScope(emptyPage, run.signal),
      undefined,
      async () => { throw new Error("a cancelled run must not reopen the form"); },
    ),
    (error: unknown) => error === cancellation,
  );
  assert.ok(Date.now() - started < 2_000, "cancellation ends the form wait before its 5 s probe");
} finally {
  await formBrowser.close();
}

// Current balances: the account overview is read first and wins when it has
// rows; the current-balance page is read only when the overview is empty.
const balanceReads: string[] = [];
const balanceInput = {
  observedAt: "2026-09-09T13:57:10+08:00",
  financialAuthority: { authorityClass: "existing-financial-admission" },
};
const overviewOnly = await hncbCurrentDepositBalances(
  async () => { balanceReads.push("overview"); return [overviewCurrentRow]; },
  async () => { balanceReads.push("detail"); return []; },
)(balanceInput);
assert.deepEqual(overviewOnly, [overviewCurrentRow]);
assert.deepEqual(balanceReads, ["overview"]);
balanceReads.length = 0;
await hncbCurrentDepositBalances(
  async () => { balanceReads.push("overview"); return []; },
  async () => { balanceReads.push("detail"); return []; },
)(balanceInput);
assert.deepEqual(balanceReads, ["overview", "detail"]);

// The build half reads current balances only after a capture was admitted as
// financial data, and only while the run is live.
function productHandle(staged: ProductStageRequest[]): ProductCollectionHandle {
  return {
    stage: (...requests) => { staged.push(...requests); },
    reportActivity: async () => undefined,
    event: async () => undefined,
  };
}
const live = { signal: new AbortController().signal };
function readCapture(account: string, label: string) {
  const structural = admitHncbDomesticDepositCaptureEvidence(buildHncbCapture(
    { value: account, label },
    { startDate: "2026/08/01", endDate: "2026/08/31" },
    "2026-08-31T12:00:00+08:00",
    {
      account: `${account.slice(0, 6)}-${account.slice(6)}`,
      accountId: account,
      queryPeriod: "2026/08/01-2026/08/31",
      currency: "TWD",
      rows: [duplicateHncbRow],
      filename: "synthetic-hncb.xls",
      byteLength: 1,
      contentDigest: `sha256:synthetic-${account}`,
    },
  ));
  assert.equal(structural.status, "admissible");
  return structural.capture!;
}
const admitted = readCapture(accountA, `HNCB ${accountA}`);
const sourceOnly = readCapture(accountB, `HNCB 共同帳戶 ${accountB}`);
let currentReads = 0;
const countingReads: HncbReadCurrentDepositBalances = async () => { currentReads += 1; return []; };

const sourceOnlyStaged: ProductStageRequest[] = [];
const sourceOnlySummary = await stageHncbDeposit(
  { observedAt: "2026-08-31T12:00:00+08:00", captures: [sourceOnly] },
  live,
  productHandle(sourceOnlyStaged),
  countingReads,
);
assert.equal(currentReads, 0, "a source-only snapshot never opens the balance pages");
assert.deepEqual(sourceOnlyStaged.map((item) => item.command.kind), [PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND]);
assert.deepEqual(sourceOnlySummary, { accountCount: 1, sourceCaptureCount: 1, rowCount: 1 });

const financialStaged: ProductStageRequest[] = [];
await stageHncbDeposit(
  { observedAt: "2026-08-31T12:00:00+08:00", captures: [admitted, sourceOnly] },
  live,
  productHandle(financialStaged),
  countingReads,
);
assert.equal(currentReads, 1);
assert.deepEqual(financialStaged.map((item) => item.command.kind), [
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
]);

const cancelledRun = new AbortController();
cancelledRun.abort(cancellation);
await assert.rejects(
  stageHncbDeposit(
    { observedAt: "2026-08-31T12:00:00+08:00", captures: [admitted] },
    { signal: cancelledRun.signal },
    productHandle([]),
    countingReads,
  ),
  (error: unknown) => error === cancellation,
);
assert.equal(currentReads, 1, "a cancelled run does not read current balances");

await assert.rejects(
  stageHncbDeposit({ observedAt: "2026-08-31T12:00:00+08:00", captures: [] }, live, productHandle([]), countingReads),
  /No HNCB accounts reached a terminal source result/u,
);
