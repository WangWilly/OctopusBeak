import assert from "node:assert/strict";
import test from "node:test";
import { SPENDING_CATEGORY_GROUP_BY_CODE, SPENDING_CATEGORY_GROUP_IDS } from "./category-groups.ts";
import {
  CLASSIFY_CODE_KEYS,
  classifyPurchaseRows,
  classifyGroupCodes,
  classifyGroupKey,
  classifyKeyCommand,
  classifyMerchantRows,
  classifyPeriod,
  classifyWriteTargets,
  followingKey,
  keepsMerchantFilter,
  movedKey,
} from "./classify-inbox.ts";
import { MAX_CATEGORIZATION_TARGETS } from "../financial/page-actions.ts";
import type { SpendingClassifyQueueItem } from "./model.ts";

test("every group's codes fit the code keys, default first, each in its own group", () => {
  for (const group of SPENDING_CATEGORY_GROUP_IDS) {
    const codes = classifyGroupCodes(group);
    assert.ok(codes.length <= CLASSIFY_CODE_KEYS.length, `${group} has more codes than keys`);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.equal(SPENDING_CATEGORY_GROUP_BY_CODE[code], group);
  }
  assert.equal(Object.keys(SPENDING_CATEGORY_GROUP_BY_CODE).length,
    SPENDING_CATEGORY_GROUP_IDS.reduce((sum, group) => sum + classifyGroupCodes(group).length, 0));
  assert.deepEqual(classifyGroupCodes("home"), ["housing_and_utilities", "household_goods_and_services", "information_and_communication"]);
  assert.equal(classifyGroupCodes("other")[0], "insurance");
});

test("keys 1–7 pick groups in page order and code keys need a picked group", () => {
  assert.deepEqual(SPENDING_CATEGORY_GROUP_IDS.map(classifyGroupKey), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.deepEqual(classifyKeyCommand("5", null), { kind: "group", group: "home" });
  assert.equal(classifyKeyCommand("8", null), null);
  assert.equal(classifyKeyCommand("0", null), null);
  assert.equal(classifyKeyCommand("a", null), null);
  assert.deepEqual(classifyKeyCommand("b", "home"), { kind: "code", code: "household_goods_and_services" });
  assert.deepEqual(classifyKeyCommand("B", "home"), { kind: "code", code: "household_goods_and_services" });
  assert.equal(classifyKeyCommand("d", "home"), null, "home has three codes");
  assert.deepEqual(classifyKeyCommand("f", "other"), { kind: "code", code: classifyGroupCodes("other")[5] });
  assert.deepEqual(classifyKeyCommand("Enter", null), { kind: "apply" });
});

test("j and k move rows even with a group picked", () => {
  for (const group of [null, ...SPENDING_CATEGORY_GROUP_IDS]) {
    assert.deepEqual(classifyKeyCommand("j", group), { kind: "move", delta: 1 });
    assert.deepEqual(classifyKeyCommand("k", group), { kind: "move", delta: -1 });
  }
  assert.deepEqual(classifyKeyCommand("ArrowDown", "home"), { kind: "move", delta: 1 });
  assert.deepEqual(classifyKeyCommand("ArrowUp", null), { kind: "move", delta: -1 });
});

test("a move stops at the ends and starts at the first row", () => {
  const keys = ["a", "b", "c"];
  assert.equal(movedKey(keys, "b", 1), "c");
  assert.equal(movedKey(keys, "c", 1), "c");
  assert.equal(movedKey(keys, "a", -1), "a");
  assert.equal(movedKey(keys, null, 1), "a");
  assert.equal(movedKey(keys, "gone", -1), "a");
  assert.equal(movedKey([], "a", 1), null);
});

test("an applied row hands current to the next row, then the previous one", () => {
  const before = ["a", "b", "c", "d"];
  assert.equal(followingKey(before, ["a", "c", "d"], "b"), "c");
  assert.equal(followingKey(before, ["a", "d"], "b"), "d", "a merchant apply can remove several rows");
  assert.equal(followingKey(before, ["a", "b"], "d"), "b");
  assert.equal(followingKey(before, ["c", "a"], "a"), "a", "a row that stays stays current");
  assert.equal(followingKey(before, [], "a"), null);
  assert.equal(followingKey(before, ["x", "y"], "b"), "x");
  assert.equal(followingKey(before, ["c"], null), "c");
});

test("the period is the twelve months ending today", () => {
  assert.deepEqual(classifyPeriod("2026-11-17"), { startDate: "2025-11-18", endDate: "2026-11-17" });
  assert.deepEqual(classifyPeriod("2026-12-31"), { startDate: "2026-01-01", endDate: "2026-12-31" });
  assert.deepEqual(classifyPeriod("2028-02-29"), { startDate: "2027-03-01", endDate: "2028-02-29" });
});

function queued(purchaseId: string, title: string, amount: string): SpendingClassifyQueueItem {
  return { purchaseId, basis: "bank-transaction", date: "2026-09-01", title, amount: { currency: "TWD", coefficient: amount, scale: 0 }, payment: null, details: { time: null, bankDescription: null, items: [] } };
}

const pxmartAndDinTaiFung = [
  queued("p1", "全聯福利中心", "300"),
  queued("p2", "全聯福利中心松江店", "300"),
  queued("p3", "全聯實業股份有限公司", "500"),
  queued("d1", "鼎泰豐", "300"),
  queued("d2", "鼎泰豐", "120"),
];
const ids = (rows: readonly { purchaseId: string }[]) => rows.map((row) => row.purchaseId);

test("「全部套用」 under 「只看」 writes only that merchant's search results", () => {
  const view = { mode: "time", query: "300", merchantKey: "全聯" } as const;
  const shown = classifyPurchaseRows(pxmartAndDinTaiFung, view);
  assert.deepEqual(ids(shown).sort(), ["p1", "p2"]);
  const written = classifyWriteTargets(pxmartAndDinTaiFung, view, { kind: "search" });
  assert.deepEqual([...written.purchaseIds].sort(), ["p1", "p2"], "the 300 at 鼎泰豐 is not on screen");
  assert.equal(written.purchaseIds.length, shown.length, "the count the footer shows is the count written");
  const everywhere = classifyWriteTargets(pxmartAndDinTaiFung, { ...view, merchantKey: null }, { kind: "search" });
  assert.deepEqual([...everywhere.purchaseIds].sort(), ["d1", "p1", "p2"]);
  assert.deepEqual(classifyWriteTargets(pxmartAndDinTaiFung, { ...view, query: "  " }, { kind: "search" }).purchaseIds, []);
});

test("a merchant row under a search shows and writes only its matching purchases", () => {
  const rows = classifyMerchantRows(pxmartAndDinTaiFung, "300");
  const pxmart = rows.find((row) => row.group.key === "全聯")!;
  assert.deepEqual(ids(pxmart.members).sort(), ["p1", "p2"]);
  assert.equal(pxmart.unmatched, 1, "「另有 1 筆不符搜尋」");
  const written = classifyWriteTargets(pxmartAndDinTaiFung, { mode: "merchant", query: "300", merchantKey: null }, { kind: "current", key: "全聯" });
  assert.deepEqual([...written.purchaseIds].sort(), ["p1", "p2"], "p3 is hidden by the search, so it is not written");
  assert.equal(written.purchaseIds.length, pxmart.members.length, "the button count is the member count shown");

  const whole = classifyMerchantRows(pxmartAndDinTaiFung, "").find((row) => row.group.key === "全聯")!;
  assert.equal(whole.members.length, 3);
  assert.equal(whole.unmatched, 0);
  assert.equal(classifyWriteTargets(pxmartAndDinTaiFung, { mode: "merchant", query: "", merchantKey: null }, { kind: "current", key: "全聯" }).purchaseIds.length, 3);
});

test("「只看」 stays while the merchant has queued purchases a search hid", () => {
  const view = { mode: "time", query: "500", merchantKey: "全聯" } as const;
  assert.equal(keepsMerchantFilter(pxmartAndDinTaiFung, view, ["p3"]), true, "p1 and p2 are still queued");
  assert.equal(keepsMerchantFilter(pxmartAndDinTaiFung, view, ["p1", "p2", "p3"]), false);
});

test("the current row writes only a row that is shown", () => {
  const view = { mode: "time", query: "", merchantKey: "全聯" } as const;
  assert.deepEqual(classifyWriteTargets(pxmartAndDinTaiFung, view, { kind: "current", key: "p3" }).purchaseIds, ["p3"]);
  assert.deepEqual(classifyWriteTargets(pxmartAndDinTaiFung, view, { kind: "current", key: "d1" }).purchaseIds, [], "鼎泰豐 is outside 「只看」");
  assert.deepEqual(classifyWriteTargets(pxmartAndDinTaiFung, { mode: "merchant", query: "", merchantKey: null }, { kind: "current", key: "missing" }).purchaseIds, []);
});

test("a merchant row over the cap reports what stays queued", () => {
  const many = Array.from({ length: MAX_CATEGORIZATION_TARGETS + 3 }, (_, index) => queued(`t${index}`, "全聯", String(index + 1)));
  const written = classifyWriteTargets(many, { mode: "merchant", query: "", merchantKey: null }, { kind: "current", key: "全聯" });
  assert.equal(written.purchaseIds.length, MAX_CATEGORIZATION_TARGETS);
  assert.equal(written.overflow, 3);
});
