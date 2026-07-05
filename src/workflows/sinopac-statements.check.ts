import assert from "node:assert/strict";
import {
  sinopacApiRowsToStatementRows,
  sinopacManualAuthMessage,
  sinopacPasswordExpiryNoticeDismissTargets,
  sinopacQueryWindows,
  sinopacSignedInPageUrl,
  sinopacStatementRowsToCsv,
} from "./sinopac-statements.ts";

assert.deepEqual(
  sinopacQueryWindows({ startDate: "20250706", endDate: "20260705" }),
  [
    { startDate: "20260405", endDate: "20260705" },
    { startDate: "20260105", endDate: "20260405" },
    { startDate: "20251005", endDate: "20260105" },
    { startDate: "20250706", endDate: "20251005" },
  ],
);

assert.equal(
  sinopacManualAuthMessage("sinopac-demo"),
  "manual-auth-required: enter the SinoPac CAPTCHA in the browser, then run `npx libretto resume --session sinopac-demo`.",
);

assert.deepEqual(sinopacPasswordExpiryNoticeDismissTargets().slice(0, 2), [
  'a:has-text("延用舊密碼"):visible',
  'button:has-text("延用舊密碼"):visible',
]);

assert.equal(
  sinopacSignedInPageUrl(
    "https://mma.sinopac.com/mma/mymma/myasset/mma_assets_summary.aspx",
  ),
  true,
);
assert.equal(
  sinopacSignedInPageUrl(
    "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
  ),
  true,
);
assert.equal(
  sinopacSignedInPageUrl("https://mma.sinopac.com/MemberPortal/Member/Trade.aspx"),
  false,
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

assert.deepEqual(rows.map((row) => row.values), [
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
  [
    "2025/10/21",
    "2025/10/21",
    "00:13",
    "利息存入",
    "",
    "6",
    "9,035",
    "",
    "",
  ],
]);

assert.equal(
  sinopacStatementRowsToCsv(rows),
  '帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註,匯率\n2025/09/29,2025/09/29,06:01,電子交易,109,,"9,029",一卡通Money自動儲值 iPASS MO,31.2\n2025/10/21,2025/10/21,00:13,利息存入,,6,"9,035",,\n',
);
