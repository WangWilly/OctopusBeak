import assert from "node:assert/strict";
import test from "node:test";
import { FUBON_SOURCE } from "./server/sources/fubon.ts";
import { sanitizedDialogAlert } from "./fubon-dialog.ts";
import { matchesTakeoverDialog } from "./sign-in-prompt.ts";

test("Fubon's takeover prompt accepts only exact 0212 codes or current duplicate-login actions", () => {
  const prompt = FUBON_SOURCE.sessionTakeover?.prompt;
  assert.ok(prompt && "dialog" in prompt, "Fubon declares its takeover as a confirm() dialog");
  assert.equal(prompt.phase, "while-settling");
  for (const message of [
    "0212",
    "00212",
    "錯誤代碼:0212",
    "errorCode=00212",
    "偵測到重複登入，是否繼續登入？",
    "偵測到重覆登入，確定仍要登入？",
    "您已在其他裝置登入，是否要繼續？",
    "You are already logged in on another device. Continue?",
  ]) {
    assert.equal(matchesTakeoverDialog(prompt, { type: "confirm", message }), true, message);
    assert.equal(matchesTakeoverDialog(prompt, { type: "alert", message }), false, message);
  }
  for (const message of [
    "02120",
    "1212",
    "0213",
    "錯誤代碼:02120",
    "錯誤代碼:1212",
    "errorCode0212something",
    "重複登入",
    "曾經重複登入，是否繼續登入？",
    "其他裝置曾登入，是否繼續？",
    "帳號已登出，其他裝置登入，是否繼續？",
    "previously logged in on another device, continue?",
    "為安全起見，是否繼續？",
    "other device login",
    "請確認是否刪除這筆資料",
  ]) {
    assert.equal(matchesTakeoverDialog(prompt, { type: "confirm", message }), false, message);
  }
});

test("a Fubon alert is kept as its sanitized code only", () => {
  assert.equal(sanitizedDialogAlert("頁面閒置過久 private-secret"), "errorCode0240");
  assert.equal(sanitizedDialogAlert("操作逾時"), "errorCode0240");
  assert.equal(sanitizedDialogAlert("登入失敗 errorCode0231 private-secret"), "errorCode0231");
  assert.equal(sanitizedDialogAlert("錯誤代碼:0290"), "errorCode0290");
  assert.equal(sanitizedDialogAlert("系統維護中 private-secret"), "dialog-alert");
});
