import assert from "node:assert/strict";
import {
  sinopacApiRowsToStatementRows,
  sinopacCaptchaAssistanceStage,
  sinopacQueryWindows,
  sinopacFilterAccounts,
  sinopacLoginEntryUrl,
  sinopacSortAccounts,
  sinopacStatementRowsToCsv,
  SINOPAC_LOGIN_URL,
} from "./sinopac-statements.ts";

assert.deepEqual(
  sinopacQueryWindows({ startDate: "20250706", endDate: "20260705" }),
  [
    { startDate: "20260605", endDate: "20260705" },
    { startDate: "20260504", endDate: "20260604" },
    { startDate: "20260403", endDate: "20260503" },
    { startDate: "20260302", endDate: "20260402" },
    { startDate: "20260201", endDate: "20260301" },
    { startDate: "20251231", endDate: "20260131" },
    { startDate: "20251130", endDate: "20251230" },
    { startDate: "20251029", endDate: "20251129" },
    { startDate: "20250928", endDate: "20251028" },
    { startDate: "20250827", endDate: "20250927" },
    { startDate: "20250726", endDate: "20250826" },
    { startDate: "20250706", endDate: "20250725" },
  ],
);
assert.deepEqual(
  sinopacQueryWindows({ startDate: "20240229", endDate: "20240331" }),
  [{ startDate: "20240229", endDate: "20240331" }],
);
assert.deepEqual(
  sinopacQueryWindows({ startDate: "20240101", endDate: "20240331" }),
  [
    { startDate: "20240229", endDate: "20240331" },
    { startDate: "20240128", endDate: "20240228" },
    { startDate: "20240101", endDate: "20240127" },
  ],
);

assert.equal(
  SINOPAC_LOGIN_URL,
  "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx",
);
const captchaSelectors: string[] = [];
const captchaStage = sinopacCaptchaAssistanceStage({
  locator(selector: string) {
    captchaSelectors.push(selector);
    return { selector };
  },
} as never);
assert.equal(captchaStage.challengeKind, "text-captcha");
assert.equal(captchaStage.charset, "digits");
assert.equal(captchaStage.imagePreprocessing, undefined);
assert.equal(captchaStage.ocrPageSegmentationMode, "single-line");
assert.deepEqual(captchaStage.ocrAttemptPlan, [
  { imagePreprocessing: ["remove-interference-lines"] },
]);
assert.deepEqual(captchaStage.solveAcceptancePolicy, {
  mode: "confidence-only",
});
assert.equal(captchaStage.solverConfidenceThreshold, 0.9);
assert.equal(captchaStage.expectedAnswerLength, 6);
assert.equal(
  captchaStage.challengeImageRegion?.semanticId,
  "sinopac.login.captcha-image",
);
assert.deepEqual(captchaSelectors, [
  'input[id$="sino_keyword3"], input[id$="_captcha"]',
  "#imgCode",
]);
assert.equal(
  sinopacLoginEntryUrl(
    "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx?from=start",
  ),
  true,
);
assert.equal(
  sinopacLoginEntryUrl(
    "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
  ),
  false,
);
assert.deepEqual(
  sinopacSortAccounts([
    { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
    { DataText: "TWD account", DataValue: "003", DisplayText: "TWD" },
    { DataText: "TWD account", DataValue: "001", DisplayText: "TWD" },
  ]).map((account) => account.DataValue),
  ["001", "003", "002"],
);
assert.deepEqual(
  sinopacFilterAccounts(
    [
      { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
      { DataText: "TWD account", DataValue: "001", DisplayText: "TWD" },
    ],
    [],
    [],
  ).map((account) => account.DataValue),
  ["001", "002"],
);
const rows = sinopacApiRowsToStatementRows([
  {
    DataText1: "2025/09/29<br />06:01",
    DataText2: "2025/09/29",
    DataText3: "電子交易",
    DataText4: '<font color="#ff6000">-109</font>',
    DataText5: "9,029",
    DataText7: "31.2",
    DataText8: "一卡通Money自動儲值<br>iPASS MO",
  },
  {
    DataText1: "2025/10/21<br />00:13",
    DataText2: "2025/10/21",
    DataText3: "利息存入",
    DataText4: '<font color="#009a12">6</font>',
    DataText5: "9,035",
  },
]);

assert.deepEqual(
  rows.map((row) => row.values),
  [
    [
      "2025/09/29",
      "2025/09/29",
      "06:01",
      "電子交易",
      "109",
      "",
      "9,029",
      "一卡通Money自動儲值 iPASS MO",
      "31.2",
    ],
    ["2025/10/21", "2025/10/21", "00:13", "利息存入", "", "6", "9,035", "", ""],
  ],
);

assert.equal(
  sinopacStatementRowsToCsv(rows),
  '帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註,匯率\n2025/09/29,2025/09/29,06:01,電子交易,109,,"9,029",一卡通Money自動儲值 iPASS MO,31.2\n2025/10/21,2025/10/21,00:13,利息存入,,6,"9,035",,\n',
);
