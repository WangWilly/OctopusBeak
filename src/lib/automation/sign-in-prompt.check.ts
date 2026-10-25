import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS } from "./server/verification-routing.ts";
import { VERIFIED_SOURCES } from "./server/sources/index.ts";
import { matchesDialogText, matchesRejectionDialog, matchesTakeoverDialog } from "./sign-in-prompt.ts";

const NOTICE = "您可能重複登入，或上次的使用未依照正常程序登出，如確定登入，系統將強制關閉他處登入狀態";

test("an exact dialog match ignores character width, whitespace and the trailing full stop only", () => {
  const match = { exact: NOTICE } as const;
  assert.equal(matchesDialogText(match, NOTICE), true);
  assert.equal(matchesDialogText(match, `${NOTICE}。`), true);
  assert.equal(matchesDialogText(match, NOTICE.replace("，", " ， ")), true);
  assert.equal(matchesDialogText(match, "驗證碼失效或輸入錯誤，請重新輸入".normalize("NFD")), false);
  assert.equal(matchesDialogText({ exact: "ＡＢＣ" }, "ABC"), true);
  assert.equal(matchesDialogText(match, `${NOTICE}，並變更密碼`), false);
  assert.equal(matchesDialogText(match, "系統將強制關閉他處登入狀態"), false);
});

test("a pattern and a predicate see the raw message", () => {
  assert.equal(matchesDialogText({ pattern: /^0290\s*驗證碼輸入錯誤$/u }, "0290 驗證碼輸入錯誤"), true);
  assert.equal(matchesDialogText({ pattern: /^0290\s*驗證碼輸入錯誤$/u }, "0290 驗證碼輸入錯誤。"), false);
  const seen: string[] = [];
  assert.equal(matchesDialogText((message) => { seen.push(message); return message.endsWith("。"); }, "x 。"), true);
  assert.deepEqual(seen, ["x 。"]);
});

test("a takeover is a confirm and a rejection is an alert, never the other way round", () => {
  const takeover = { phase: "while-settling", dialog: { exact: NOTICE } } as const;
  assert.equal(matchesTakeoverDialog(takeover, { type: "confirm", message: `${NOTICE}。` }), true);
  assert.equal(matchesTakeoverDialog(takeover, { type: "alert", message: NOTICE }), false);
  assert.equal(matchesTakeoverDialog(undefined, { type: "confirm", message: NOTICE }), false);
  const page = { phase: "before-submit", text: { exact: NOTICE }, control: { text: "登出" } } as const;
  assert.equal(matchesTakeoverDialog(page, { type: "confirm", message: NOTICE }), false);

  const rejection = { dialog: { exact: "圖形驗證錯誤" } } as const;
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: " 圖形驗證錯誤 " }), true);
  assert.equal(matchesRejectionDialog(rejection, { type: "confirm", message: "圖形驗證錯誤" }), false);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: "圖形驗證錯誤，帳號已鎖定" }), false);
  assert.equal(matchesRejectionDialog("workflow", { type: "alert", message: "圖形驗證錯誤" }), false);
  assert.equal(matchesRejectionDialog({ frame: "txnFrame", text: { exact: "圖形驗證錯誤" } }, { type: "alert", message: "圖形驗證錯誤" }), false);
  assert.equal(matchesRejectionDialog(undefined, { type: "alert", message: "圖形驗證錯誤" }), false);
});

test("the sources that prove their own CAPTCHA rejection are the ones the coordinator joins", () => {
  assert.deepEqual(
    [...WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS].sort(),
    ["einvoice-personal-invoices", "fubon-all-statements", "post-statements", "sinopac-statements", "yuanta-all-statements"],
  );
  const probed = VERIFIED_SOURCES
    .filter((source) => source.workflow.verification !== undefined && source.workflow.verification.rejection === undefined)
    .map((source) => source.task.id);
  assert.deepEqual(probed.sort(), ["hncb-statements", "yuanta-trade-statements"]);
});

test("the eight sources that sign the person out elsewhere disclose it, and a prompt never stands alone", () => {
  const disclosed = VERIFIED_SOURCES.filter((source) => source.sessionTakeover).map((source) => source.id);
  assert.deepEqual(disclosed.sort(), ["cathay", "ctbc", "einvoice", "esun", "fubon", "sinopac", "tdcc", "yuanta"]);
  for (const source of VERIFIED_SOURCES) {
    if (source.sessionTakeover?.prompt) assert.ok(source.sessionTakeover.notice.en.length > 0);
  }
});
