import assert from "node:assert/strict";
import test from "node:test";
import { SPENDING_CATEGORY_GROUP_BY_CODE, SPENDING_CATEGORY_GROUP_IDS } from "./category-groups.ts";
import {
  CLASSIFY_CODE_KEYS,
  classifyGroupCodes,
  classifyGroupKey,
  classifyKeyCommand,
  classifyPeriod,
  followingKey,
  movedKey,
} from "./classify-inbox.ts";

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
