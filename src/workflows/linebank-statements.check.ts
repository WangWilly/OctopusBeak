import assert from "node:assert/strict";
import {
  linebankAccountCurrency,
  linebankApiRowsToStatementRows,
  linebankQueryWindows,
  linebankStatementRowsToCsv,
} from "./linebank-statements.ts";

assert.deepEqual(
  linebankQueryWindows({ startDate: "20250706", endDate: "20260705" }),
  [{ startDate: "20250706", endDate: "20260705" }],
);

assert.deepEqual(
  linebankQueryWindows({ startDate: "20240101", endDate: "20260705" }),
  [
    { startDate: "20250706", endDate: "20260705" },
    { startDate: "20240706", endDate: "20250705" },
    { startDate: "20240101", endDate: "20240705" },
  ],
);

assert.equal(linebankAccountCurrency({ acctNbr: "1" }), "TWD");
assert.equal(linebankAccountCurrency({ acctNbr: "1", currCd: "usd" }), "USD");

const rows = linebankApiRowsToStatementRows([
  {
    txDt: "20260705",
    txTm: "143738",
    dpstWdrwDsCd: "1",
    bizTxFuncTpNm: "轉帳",
    txAmt: 1000,
    afTxBal: 1005,
    txRmkCont: "匯入",
    txMemoVal: "備註",
  },
  {
    txDt: "20260704",
    txTm: "080102",
    dpstWdrwDsCd: "2",
    bizTxFuncTpNm: "提款",
    txAmt: 250,
    afTxBal: 5,
    txRmkCont: "",
    txMemoVal: "",
  },
]);

assert.deepEqual(rows.map((row) => row.values), [
  [
    "2026/07/05",
    "2026/07/05",
    "14:37:38",
    "轉帳",
    "",
    "1000",
    "1005",
    "匯入 備註",
    "",
  ],
  ["2026/07/04", "2026/07/04", "08:01:02", "提款", "250", "", "5", "", ""],
]);

assert.equal(
  linebankStatementRowsToCsv(rows),
  "帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註,匯率\n2026/07/05,2026/07/05,14:37:38,轉帳,,1000,1005,匯入 備註,\n2026/07/04,2026/07/04,08:01:02,提款,250,,5,,\n",
);
