import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTargets,
  byTime,
  byMerchant,
  matches,
  merchantKey,
} from "./classify-queue.ts";
import { MAX_CATEGORIZATION_TARGETS } from "../financial/page-actions.ts";
import type { SpendingClassifyQueueItem } from "./model.ts";

function item(purchaseId: string, title: string | null, amount: string | null, date = "2026-09-01"): SpendingClassifyQueueItem {
  return {
    purchaseId,
    basis: "bank-transaction",
    date,
    title,
    amount: amount === null ? null : { currency: "TWD", coefficient: amount, scale: 0 },
    payment: null,
    details: { time: null, bankDescription: null, items: [] },
  };
}

test("merchantKey merges the bank, invoice and branch spellings of one chain", () => {
  const pxmart = [
    "全聯福利中心",
    "全聯福利中心－台北民生",
    "全聯福利中心松江店",
    "全聯實業股份有限公司",
    "全聯實業股份有限公司頭城青雲分公司",
    "ＬＩＮＥ　Ｐａｙ－全聯福利中心",
    "街口支付 全聯福利中心0123",
  ];
  assert.deepEqual(new Set(pxmart.map(merchantKey)), new Set(["全聯"]));
  const seven = ["統一超商", "統一超商－蘭雲", "統一超商股份有限公司宜蘭縣第一三二分公司", "7-ELEVEN 松江門市", "７－ＥＬＥＶＥＮ"];
  assert.deepEqual(new Set(seven.map(merchantKey)), new Set(["7-eleven"]));
  assert.deepEqual(new Set(["星巴克－信義誠品門市", "統一星巴克股份有限公司"].map(merchantKey)), new Set(["星巴克"]));
  assert.deepEqual(new Set(["全家便利商店 信義店", "全家便利商店股份有限公司"].map(merchantKey)), new Set(["全家"]));
});

test("merchantKey trims branches and store numbers of merchants it has no alias for", () => {
  assert.equal(merchantKey("鼎泰豐－信義店"), "鼎泰豐");
  assert.equal(merchantKey("大苑子 台北南京店"), "大苑子");
  assert.equal(merchantKey("寶雅生活館股份有限公司"), "寶雅生活館");
  assert.equal(merchantKey("健康藥局中山店"), "健康藥局");
  assert.equal(merchantKey("Cafe Nero #0042"), "cafe nero");
  assert.equal(merchantKey("  ＵＢＥＲ　ＥＡＴＳ "), "uber eats");
});

test("merchantKey keeps different merchants apart", () => {
  assert.notEqual(merchantKey("UBER EATS"), merchantKey("UBER TRIP"));
  assert.notEqual(merchantKey("大全聯"), merchantKey("全聯福利中心"));
  assert.equal(merchantKey("全家便利商店"), "全家");
  assert.equal(merchantKey("LINE Pay卡 正卡"), "line pay卡 正卡", "a card product name is not a channel prefix");
  assert.equal(merchantKey("消費 誠品"), "消費 誠品", "text after a space is not cut unless it names a branch");
  assert.equal(merchantKey(null), "");
  assert.equal(merchantKey("   "), "");
});

test("merchantKey keys a deposit's 摘要 · 備註 on the payee, never on the transaction type", () => {
  const descriptions = [
    "金融卡消費 · 全聯福利中心",
    "金融卡消費 · 鼎泰豐",
    "全國繳費 · 台灣電力",
    "全國繳費 · 中華電信",
    "行動支付 · 星巴克",
    "消費 · 誠品",
    "金融卡消費 · 00123",
    "金融卡消費 · 00456",
  ];
  const keys = descriptions.map(merchantKey);
  assert.equal(new Set(keys).size, descriptions.length, keys.join(" | "));
  assert.deepEqual(keys.slice(0, 6), ["全聯", "鼎泰豐", "台灣電力", "中華電信", "星巴克", "誠品"]);
  assert.equal(merchantKey("金融卡消費 · 全聯福利中心"), merchantKey("全聯實業股份有限公司"));
});

test("byMerchant groups by merchant key, the group with the latest purchase first", () => {
  const rows = [
    item("transaction:1", "全聯福利中心－台北民生", "300", "2026-09-01"),
    item("invoice:2", "全聯實業股份有限公司", "120", "2026-09-10"),
    item("transaction:3", "全聯福利中心", "80", "2026-09-04"),
    item("transaction:4", "鼎泰豐－信義店", "2400", "2026-09-12"),
    item("transaction:5", "鼎泰豐", "900", "2026-09-02"),
    item("transaction:6", "UBER TRIP", "3000", "2026-09-08"),
    item("invoice:7", null, "40", "2026-09-03"),
  ];
  const groups = byMerchant(rows);
  assert.deepEqual(groups.map((group) => [group.key, group.count]), [
    ["鼎泰豐", 2], ["全聯", 3], ["uber trip", 1], ["purchase:invoice:7", 1],
  ], "a merchant's latest purchase places it, not how many it has");
  const pxmart = groups[1]!;
  assert.equal(pxmart.displayName, "全聯福利中心", "ties between titles go to the shorter one");
  assert.deepEqual(pxmart.totals, [{ currency: "TWD", coefficient: "500", scale: 0, count: 3 }]);
  assert.deepEqual(pxmart.purchaseIds, ["invoice:2", "transaction:3", "transaction:1"], "members newest first");
  assert.equal(groups[0]!.displayName, "鼎泰豐");
});

test("matches finds a row by title text, merchant alias, or exact amount", () => {
  const row = item("transaction:1", "統一超商－蘭雲", "1250");
  assert.ok(matches(row, ""));
  assert.ok(matches(row, "蘭雲"));
  assert.ok(matches(row, "7-11"));
  assert.ok(matches(row, "１２５０"));
  assert.ok(matches(row, "1,250"));
  assert.ok(!matches(row, "125"));
  assert.ok(!matches(row, "全家"));
});

test("a branch-specific search matches only that branch, never the whole chain", () => {
  const rows = [
    item("transaction:1", "全聯福利中心松江店", "300"),
    item("transaction:2", "全聯福利中心－台北民生", "200"),
    item("invoice:3", "全聯實業股份有限公司", "100"),
    item("transaction:4", "統一超商－蘭雲", "90"),
    item("transaction:5", "統一超商－松江", "80"),
  ];
  const found = (query: string) => rows.filter((row) => matches(row, query)).map((row) => row.purchaseId);
  assert.deepEqual(found("全聯福利中心松江店"), ["transaction:1"]);
  assert.deepEqual(found("7-11 蘭雲"), []);
  assert.deepEqual(found("統一超商－蘭雲"), ["transaction:4"]);
  assert.deepEqual(found("全聯"), ["transaction:1", "transaction:2", "invoice:3"]);
  assert.deepEqual(found("7-11"), ["transaction:4", "transaction:5"]);
  assert.deepEqual(applyTargets(rows, { kind: "search", query: "全聯福利中心松江店" }).purchaseIds, ["transaction:1"]);
});

test("an apply scope resolves to the queued purchases it names, capped per action", () => {
  const rows = [
    item("transaction:1", "全聯福利中心", "300"),
    item("invoice:2", "全聯實業股份有限公司", "500"),
    item("transaction:3", "鼎泰豐", "80"),
  ];
  assert.deepEqual(applyTargets(rows, { kind: "one", purchaseId: "transaction:3" }), { purchaseIds: ["transaction:3"], overflow: 0 });
  assert.deepEqual(applyTargets(rows, { kind: "one", purchaseId: "transaction:9" }), { purchaseIds: [], overflow: 0 });
  assert.deepEqual(applyTargets(rows, { kind: "merchant", key: "全聯" }), { purchaseIds: ["invoice:2", "transaction:1"], overflow: 0 });
  assert.deepEqual(applyTargets(rows, { kind: "search", query: "全聯" }), { purchaseIds: ["invoice:2", "transaction:1"], overflow: 0 });
  assert.deepEqual(applyTargets(rows, { kind: "search", query: "  " }), { purchaseIds: [], overflow: 0 });

  const many = Array.from({ length: MAX_CATEGORIZATION_TARGETS + 5 }, (_, index) =>
    item(`transaction:${String(index).padStart(5, "0")}`, "全聯", "1", index === 7 ? "2026-09-30" : "2026-09-01"));
  const capped = applyTargets(many, { kind: "merchant", key: "全聯" });
  assert.equal(capped.purchaseIds.length, MAX_CATEGORIZATION_TARGETS);
  assert.equal(capped.overflow, 5);
  assert.equal(capped.purchaseIds[0], "transaction:00007", "the newest purchases go first");
});

test("byTime puts the newest purchase first, the timed ones before a date-only one that day", () => {
  const timed = (id: string, date: string, time: string | null) => ({ ...item(id, "x", "1", date), details: { time, bankDescription: null, items: [] } });
  const rows = [
    timed("transaction:old", "2026-09-01", "23:00"),
    timed("transaction:dateOnly", "2026-09-03", null),
    timed("transaction:morning", "2026-09-03", "08:15"),
    timed("transaction:evening", "2026-09-03", "19:40"),
  ];
  assert.deepEqual(byTime(rows).map((row) => row.purchaseId), ["transaction:evening", "transaction:morning", "transaction:dateOnly", "transaction:old"]);
});
