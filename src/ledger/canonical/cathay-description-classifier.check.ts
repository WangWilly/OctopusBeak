import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCathayDescription } from "./cathay-description-classifier.ts";

const kindOf = (description: string, direction: "inflow" | "outflow") =>
  classifyCathayDescription(description, direction).candidates[0]?.value ?? null;

test("Cathay's own passbook labels name their Kind", () => {
  for (const [description, direction, value] of [
    ["自行提款", "outflow", "cash.withdrawal"],
    ["跨行提款", "outflow", "cash.withdrawal"],
    ["無卡提款", "outflow", "cash.withdrawal"],
    ["ＡＴＭ存", "inflow", "cash.deposit"],
    ["ATM存", "inflow", "cash.deposit"],
    ["網銀轉帳", "outflow", "transfer"],
    ["網銀轉帳", "inflow", "transfer"],
    ["跨行轉入", "inflow", "transfer.external"],
    ["存款息", "inflow", "interest.earned"],
    ["跨行費用", "outflow", "fee.bank"],
  ] as const)
    assert.equal(kindOf(description, direction), value, `${description} ${direction}`);
});

test("a Cathay label on the direction it never moves, or as part of a longer description, stays unsupported", () => {
  for (const [description, direction] of [
    ["自行提款", "inflow"],
    ["ＡＴＭ存", "outflow"],
    ["存款息", "outflow"],
    ["跨行費用", "inflow"],
    ["跨行轉入", "outflow"],
    ["跨行提款手續費退還", "inflow"],
  ] as const)
    assert.deepEqual(classifyCathayDescription(description, direction), { candidates: [], tie: false }, `${description} ${direction}`);
});
