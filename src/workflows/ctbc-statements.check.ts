import assert from "node:assert/strict";
import {
  ctbcDetailRowsToStatementRows,
  ctbcStatementRowsToCsv,
} from "./ctbc-statements.ts";

const rows = ctbcDetailRowsToStatementRows(
  { accountId: "123456", label: "新臺幣-123456" },
  [
    {
      actDtFull: "2026/07/03",
      trnDtFull: "2026/07/02",
      actDtTm: "2026-07-03-09.08.07.000000",
      memo1: "薪資",
      memo2: "七月",
      passBookMemo: "公司,入帳",
      dbAmtDisplay: "0",
      crAmtDisplay: "1,234",
      balanceAmt: "5,678",
      sortActDtTm: "2026 07 03 09:08:07 000",
    },
  ],
);

assert.deepEqual(rows.map((row) => row.values), [
  ["2026/07/03", "2026/07/02", "09:08:07", "薪資", "0", "1,234", "5,678", "公司,入帳 七月"],
]);

assert.equal(
  ctbcStatementRowsToCsv(rows),
  '帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註\n2026/07/03,2026/07/02,09:08:07,薪資,0,"1,234","5,678","公司,入帳 七月"\n',
);
