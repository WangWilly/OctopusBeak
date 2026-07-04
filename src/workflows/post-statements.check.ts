import assert from "node:assert/strict";
import {
  postDetailLinkSelector,
  postLoginFieldValues,
  postManualAuthMessage,
  postRowsToStatementRows,
  postStatementRowsToCsv,
} from "./post-statements.ts";

assert.equal(
  postManualAuthMessage("ses-1p4q"),
  "manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-1p4q`.",
);

assert.deepEqual(
  postLoginFieldValues({
    post_user_id: "A123456789",
    post_account: "user-code",
    post_password: "pw",
  }),
  { cifId: "A123456789", userCode: "user-code", password: "pw" },
);

assert.equal(postDetailLinkSelector(true), "a.btn_td_orange_dtl:visible");

const rows = postRowsToStatementRows("123456", [
  {
    PRS_DATE: "1150704",
    TX_TIME: "091502",
    MEM: "薪資",
    TX_AMT: "123.45",
    BAL_AMT: "1000.00",
    DR_FLG: "+",
    ATTACH_COMMENT: "備註",
  },
]);

assert.deepEqual(rows.map((row) => row.values), [
  ["2026/07/04", "2026/07/04", "09:15:02", "薪資", "", "123.45", "1000.00", "備註"],
]);

assert.equal(
  postStatementRowsToCsv(rows),
  "帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註\n2026/07/04,2026/07/04,09:15:02,薪資,,123.45,1000.00,備註\n",
);
