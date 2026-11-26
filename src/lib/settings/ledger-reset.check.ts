import assert from "node:assert/strict";
import test from "node:test";
import type { DamagedLedgerSummaryDto, LedgerResetPart, LedgerResetResult } from "../desktop/api.ts";
import { settingsCopy } from "./copy.ts";
import { ledgerResetChoices, ledgerResetFailureText, runLedgerReset, tickLedgerResetPart } from "./ledger-reset.ts";

const box = (ticked: ReadonlySet<LedgerResetPart>, part: LedgerResetPart, damaged: DamagedLedgerSummaryDto | null = null) =>
  ledgerResetChoices(ticked, damaged).options.find((option) => option.part === part)!;

test("nothing is ticked at first, so there is nothing to confirm", () => {
  const choices = ledgerResetChoices(new Set());
  assert.deepEqual(choices.options.map(({ part, checked, locked }) => [part, checked, locked]), [
    ["financial", false, false],
    ["preview", false, false],
    ["manual", false, false],
    ["sign-in", false, false],
  ]);
  assert.deepEqual(choices.parts, []);
  assert.equal(choices.canConfirm, false);
});

test("ticking the financial data ticks and locks preview data, and unticking it gives the preview box back as it was", () => {
  let ticked = tickLedgerResetPart(new Set(), "financial", true);
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: true, locked: true, held: null });
  assert.deepEqual(ledgerResetChoices(ticked).parts, ["financial", "preview"], "the reset deletes preview data too");

  assert.equal(tickLedgerResetPart(ticked, "preview", false), ticked, "a locked box does not change");
  ticked = tickLedgerResetPart(ticked, "financial", false);
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: false, locked: false, held: null });

  ticked = tickLedgerResetPart(tickLedgerResetPart(new Set(), "preview", true), "financial", true);
  ticked = tickLedgerResetPart(ticked, "financial", false);
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: true, locked: false, held: null }, "a preview box the person ticked stays ticked");
});

test("the confirm button counts what is ticked, in the order the reset runs them", () => {
  const ticked = new Set<LedgerResetPart>(["sign-in", "manual"]);
  const choices = ledgerResetChoices(ticked);
  assert.deepEqual(choices.parts, ["manual", "sign-in"]);
  assert.equal(choices.canConfirm, true);
  assert.equal(settingsCopy["zh-TW"].settings.resetLedgerConfirm(choices.parts.length), "刪除 2 項");
  assert.equal(settingsCopy.en.settings.resetLedgerConfirm(choices.parts.length), "Delete 2 items");
  assert.equal(settingsCopy.en.settings.resetLedgerConfirm(1), "Delete 1 item");
  assert.equal(settingsCopy["zh-TW"].settings.resetLedgerConfirm(0), "刪除", "a disabled button names no count");
});

test("the reset's answer becomes what the data section shows", async () => {
  const asked: unknown[] = [];
  const bridge = (answer: () => Promise<LedgerResetResult>) => ({
    resetLedger: (parts: readonly LedgerResetPart[]) => {
      asked.push(parts);
      return answer();
    },
  });
  assert.deepEqual(
    await runLedgerReset(bridge(async () => ({ done: ["financial", "preview"], failed: null, notRun: [] })), ["financial", "preview"]),
    { kind: "done", done: ["financial", "preview"] },
  );
  assert.deepEqual(
    await runLedgerReset(bridge(async () => ({ done: ["manual"], failed: "sign-in", notRun: [] })), ["manual", "sign-in"]),
    { kind: "failed", done: ["manual"], failed: "sign-in", notRun: [] },
  );
  assert.deepEqual(
    await runLedgerReset(bridge(async () => { throw new Error("The ledger cannot be reset while a cleanup runs."); }), ["manual"]),
    { kind: "failed", done: [], failed: null, notRun: ["manual"] },
    "a refused reset is known to have done nothing",
  );
  assert.deepEqual(asked, [["financial", "preview"], ["manual", "sign-in"], ["manual"]]);

  const zh = settingsCopy["zh-TW"].settings;
  assert.equal(
    zh.resetLedgerFailed(zh.resetLedgerParts["sign-in"], zh.resetLedgerList([zh.resetLedgerParts.manual]), null),
    "無法刪除金融機構的登入資料。已刪除：人工填入的財務資料。可以再試一次。",
  );
});

test("a failure says nothing was deleted only when that is true", () => {
  const en = settingsCopy.en.settings;
  const zh = settingsCopy["zh-TW"].settings;
  const financial = { kind: "failed", done: [], failed: "financial", notRun: ["preview", "sign-in"] } as const;
  assert.equal(
    ledgerResetFailureText(financial, en),
    "The reset of financial data from financial institutions did not finish, and the cleanup backup may already be removed. Not deleted: Preview data (financial institutions), Sign-in data for financial institutions. Try again.",
  );
  assert.equal(
    ledgerResetFailureText(financial, zh),
    "金融機構的財務資料沒有重置完成，清理應用資料的備份可能已經刪除。未刪除：預覽資料（金融機構）、金融機構的登入資料。請再試一次。",
  );
  assert.doesNotMatch(ledgerResetFailureText({ ...financial, notRun: [] }, en), /Nothing was deleted/u);
  assert.match(ledgerResetFailureText({ kind: "failed", done: [], failed: "manual", notRun: [] }, en), /Nothing was deleted/u);
  assert.equal(ledgerResetFailureText({ kind: "failed", done: [], failed: null, notRun: ["manual"] }, zh), "無法重置帳本，請再試一次。");
});

const DAMAGED: DamagedLedgerSummaryDto = { count: 2, bytes: 412 * 1024 * 1024, hold: null };

test("the damaged-ledger box shows only while one exists, after preview data, and names how many and their size", () => {
  assert.equal(ledgerResetChoices(new Set()).options.some((option) => option.part === "damaged"), false, "none, so no box");
  assert.deepEqual(ledgerResetChoices(new Set(), DAMAGED).options.map(({ part }) => part), ["financial", "preview", "damaged", "manual", "sign-in"]);
  assert.deepEqual(box(new Set(), "damaged", DAMAGED), { part: "damaged", checked: false, locked: false, held: null });

  const zh = settingsCopy["zh-TW"].settings;
  const en = settingsCopy.en.settings;
  assert.equal(zh.resetLedgerDamagedLabel(2, "412"), "2 個損壞的帳本紀錄（約 412 MB）");
  assert.equal(zh.resetLedgerDamagedLabel(2, null), "2 個損壞的帳本紀錄", "no size when one could not be measured");
  assert.equal(en.resetLedgerDamagedLabel(1, "3.4"), "1 damaged ledger record (about 3.4 MB)");
  assert.equal(en.resetLedgerDamagedLabel(3, "412"), "3 damaged ledger records (about 412 MB)");
  assert.equal(en.resetLedgerDamagedLabel(3, null), "3 damaged ledger records");
  assert.equal(zh.resetLedgerPartHints.damaged, "毀損的帳本備援紀錄，刪除後無法取回。聯繫客服嘗試修復毀損的資料。");
  assert.equal(en.resetLedgerPartHints.damaged, "Backup records of damaged ledgers. They cannot be recovered once deleted. Contact support to try to repair the damaged data.");
});

test("ticked on its own the damaged ledgers count as one item; financial data ticks and locks them, and unticking gives the choice back", () => {
  let ticked = tickLedgerResetPart(new Set(), "damaged", true);
  assert.deepEqual(ledgerResetChoices(ticked, DAMAGED).parts, ["damaged"]);
  assert.equal(settingsCopy.en.settings.resetLedgerConfirm(ledgerResetChoices(ticked, DAMAGED).parts.length), "Delete 1 item");

  ticked = tickLedgerResetPart(new Set(), "financial", true);
  assert.deepEqual(box(ticked, "damaged", DAMAGED), { part: "damaged", checked: true, locked: true, held: null });
  assert.deepEqual(ledgerResetChoices(ticked, DAMAGED).parts, ["financial", "preview", "damaged"], "counted like any other ticked box");
  assert.equal(settingsCopy["zh-TW"].settings.resetLedgerConfirm(3), "刪除 3 項");
  assert.equal(tickLedgerResetPart(ticked, "damaged", false), ticked, "a locked box does not change");
  assert.deepEqual(box(tickLedgerResetPart(ticked, "financial", false), "damaged", DAMAGED).checked, false);

  ticked = tickLedgerResetPart(tickLedgerResetPart(new Set(), "damaged", true), "financial", true);
  assert.equal(box(tickLedgerResetPart(ticked, "financial", false), "damaged", DAMAGED).checked, true, "the person's own tick comes back");
  assert.deepEqual(ledgerResetChoices(ticked).parts, ["financial", "preview"], "gone meanwhile: no box, and nothing to delete");
});

test("damaged ledgers a restore keeps cannot be ticked on their own, and say why; financial data still locks them in", () => {
  const zh = settingsCopy["zh-TW"].settings;
  const en = settingsCopy.en.settings;
  for (const hold of ["restore-under-way", "restore-unreadable"] as const) {
    const held = { ...DAMAGED, hold };
    const ticked = tickLedgerResetPart(new Set(), "damaged", true);
    assert.deepEqual(box(ticked, "damaged", held), { part: "damaged", checked: false, locked: false, held: hold }, `${hold}: disabled and unticked`);
    assert.deepEqual(ledgerResetChoices(ticked, held).parts, [], "nothing to confirm");
    assert.equal(ledgerResetChoices(ticked, held).canConfirm, false);
    const withFinancial = tickLedgerResetPart(ticked, "financial", true);
    assert.deepEqual(box(withFinancial, "damaged", held), { part: "damaged", checked: true, locked: true, held: null },
      "the Canonical Reset removes them and the restore's files together");
    assert.ok(en.resetLedgerDamagedHeld[hold].length > 0);
  }
  assert.equal(zh.resetLedgerDamagedHeld["restore-under-way"], "還原尚未完成，暫時無法刪除。");
  assert.equal(zh.resetLedgerDamagedHeld["restore-unreadable"], "有一份無法讀取的還原紀錄，為了安全不會單獨刪除。勾選「金融機構的財務資料」會一併清除。");
});

test("a failed damaged-ledger part is named like any other", () => {
  const zh = settingsCopy["zh-TW"].settings;
  assert.equal(
    ledgerResetFailureText({ kind: "failed", done: ["preview"], failed: "damaged", notRun: ["manual"] }, zh),
    zh.resetLedgerFailed("損壞的帳本紀錄", zh.resetLedgerList([zh.resetLedgerParts.preview]), zh.resetLedgerList([zh.resetLedgerParts.manual])),
  );
  assert.equal(settingsCopy.en.settings.resetLedgerParts.damaged, "Damaged ledger records");
});
