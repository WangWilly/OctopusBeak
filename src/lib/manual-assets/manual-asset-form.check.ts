import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import { checkedCommand, sendCommand } from "./manual-asset-form.ts";
import { MANUAL_ASSET_REJECTION_CODES, type ManualAssetCommandResult } from "./manual-assets.ts";

const zh = translations["zh-TW"];
const house = (valuedOn: string) => ({
  kind: "createAsset", category: "house", name: "家", currency: "TWD",
  firstValuation: { valuedOn, amount: "100", source: "own_estimate", note: null },
});

test("the form refuses a date after today with the future-date message before sending", () => {
  assert.deepEqual(checkedCommand(house("2026-11-02"), "2026-11-01", zh), { ok: false, message: "日期不能晚於今天。" });
  assert.equal(checkedCommand(house("2026-11-01"), "2026-11-01", zh).ok, true);
});

test("a code returned by the worker becomes its own message in each language", async () => {
  const sent: unknown[] = [];
  let reply: ManualAssetCommandResult = { ok: false, code: "transfer_currency_mismatch" };
  Object.assign(globalThis, { window: { octopusBeak: { manualAssets: { apply: async (command: unknown) => (sent.push(command), reply) } } } });
  const command = { kind: "deleteAllManualAssets" } as const;
  assert.equal(await sendCommand(command, zh), "轉帳的兩個現金帳戶必須是相同幣別。");
  assert.equal(await sendCommand(command, translations.en), "A transfer needs two cash accounts in the same currency.");
  reply = { ok: true, revision: 3 };
  assert.equal(await sendCommand(command, zh), null);
  assert.equal(sent.length, 3);
  for (const code of MANUAL_ASSET_REJECTION_CODES)
    assert.notEqual(zh.manualAssets.rejections[code], translations.en.manualAssets.rejections[code], `${code} has its own zh-TW message`);
});
