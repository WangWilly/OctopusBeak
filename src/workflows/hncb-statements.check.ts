import assert from "node:assert/strict";
import { chromium, type Frame, type Page } from "playwright";
import {
  emitHumanAssistanceStage,
} from "./human-assistance.ts";
import {
  hncbCaptchaAssistanceStage,
  ensureHncbStatementForm,
  isNoStatementDataText,
  normalizeHncbTransactionRows,
  parseStatementExport,
  prepareHncbStatementQueryForm,
} from "./hncb-statements.ts";

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
