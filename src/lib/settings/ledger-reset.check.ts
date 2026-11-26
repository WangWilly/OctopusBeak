import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerResetPart, LedgerResetResult } from "../desktop/api.ts";
import { settingsCopy } from "./copy.ts";
import { ledgerResetChoices, runLedgerReset, tickLedgerResetPart } from "./ledger-reset.ts";

const box = (ticked: ReadonlySet<LedgerResetPart>, part: LedgerResetPart) =>
  ledgerResetChoices(ticked).options.find((option) => option.part === part)!;

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
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: true, locked: true });
  assert.deepEqual(ledgerResetChoices(ticked).parts, ["financial", "preview"], "the reset deletes preview data too");

  assert.equal(tickLedgerResetPart(ticked, "preview", false), ticked, "a locked box does not change");
  ticked = tickLedgerResetPart(ticked, "financial", false);
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: false, locked: false });

  ticked = tickLedgerResetPart(tickLedgerResetPart(new Set(), "preview", true), "financial", true);
  ticked = tickLedgerResetPart(ticked, "financial", false);
  assert.deepEqual(box(ticked, "preview"), { part: "preview", checked: true, locked: false }, "a preview box the person ticked stays ticked");
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
