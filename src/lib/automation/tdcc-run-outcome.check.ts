import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import { tdccExclusionLines } from "./tdcc-run-outcome.ts";

test("TDCC exclusions read as plain counts and leave out what the run did not report", () => {
  const counts = {
    excludedUnknownInstitutionCount: 2,
    excludedNonIsoCurrencyCount: 0,
    excludedTimeDepositCount: 3,
    hiddenAccountCount: 1,
    rowCount: 40,
  };
  assert.deepEqual(tdccExclusionLines(counts, translations["zh-TW"]), [
    "2 個帳戶的銀行或券商代碼尚未收錄。",
    "3 筆定期存款目前不匯入。",
    "1 個帳戶在集保 e 存摺手機 App 中設為隱藏。",
  ]);
  assert.deepEqual(tdccExclusionLines(counts, translations.en), [
    "2 accounts are at a bank or broker code OctopusBeak does not know yet.",
    "3 time deposits are not imported yet.",
    "1 account is hidden in the TDCC e-Passbook phone App.",
  ]);
  assert.deepEqual(tdccExclusionLines({ rowCount: 40 }, translations.en), []);
});
