import assert from "node:assert/strict";
import test from "node:test";
import {
  allocationRemainder,
  categoryAllocationProblem,
  normalizeTagLabel,
  noteProblem,
  noteText,
  parseAllocationAmount,
  tagDisplayLabel,
  tagLabelProblem,
} from "./transaction-detail.ts";

const twd = (coefficient: string, scale = 0) => ({ coefficient, scale, currency: "TWD" });
const part = (categoryCode: string, coefficient: string, scale = 0) => ({ categoryCode, amount: twd(coefficient, scale) });

test("an allocation is complete only when its registered, distinct, positive components sum exactly to the booked amount", () => {
  const booked = twd("125050", 2);
  assert.equal(categoryAllocationProblem(booked, [part("dining", "1000"), part("travel", "25050", 2)]), null);
  assert.equal(categoryAllocationProblem(booked, [part("dining", "12505", 1)]), "too_few");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "1000"), part("travel", "25049", 2)]), "sum", "one cent short is not complete");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "1000"), part("travel", "25051", 2)]), "sum", "one cent over is not complete");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "1000"), part("dining", "25050", 2)]), "duplicate_category");
  assert.equal(categoryAllocationProblem(booked, [part("other", "1000"), part("travel", "25050", 2)]), "unknown_category");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "125050", 2), part("travel", "0")]), "not_positive");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "-100"), part("travel", "135050", 2)]), "not_positive");
  assert.equal(categoryAllocationProblem(booked, [part("dining", "1000"), part("travel", "250501", 3)]), "too_precise");
  assert.equal(categoryAllocationProblem(twd("1000"), [part("dining", "5000", 1), part("travel", "500")]), null, "trailing zeros are not extra precision");
  assert.equal(categoryAllocationProblem(booked, [{ categoryCode: "dining", amount: { ...twd("1000"), currency: "usd" } }, part("travel", "25050", 2)]), "currency");
  assert.equal(categoryAllocationProblem({ ...booked, currency: "twd" }, [part("dining", "1000"), part("travel", "25050", 2)]), null, "currency compares upper-cased");
});

test("the remainder is the exact booked amount less the components, never a float", () => {
  assert.deepEqual(allocationRemainder({ coefficient: "3", scale: 1 }, [{ amount: { coefficient: "1", scale: 1 } }, { amount: { coefficient: "1", scale: 1 } }]), { coefficient: "1", scale: 1 });
  assert.deepEqual(allocationRemainder({ coefficient: "1000", scale: 0 }, [{ amount: { coefficient: "1200", scale: 0 } }]), { coefficient: "-200", scale: 0 });
  assert.deepEqual(allocationRemainder({ coefficient: "1000", scale: 0 }, []), { coefficient: "1000", scale: 0 });
});

test("a typed amount reads digits, a decimal point and thousands commas, and nothing else", () => {
  assert.deepEqual(parseAllocationAmount(" 1,234.50 "), { coefficient: "12345", scale: 1 });
  assert.deepEqual(parseAllocationAmount("600"), { coefficient: "600", scale: 0 });
  assert.deepEqual(parseAllocationAmount("0.10"), { coefficient: "1", scale: 1 });
  for (const text of ["", "-5", "1e3", "1,23", "12.", ".5", "NaN", "１２"]) assert.equal(parseAllocationAmount(text), null, text);
});

test("Tag labels are shown trimmed and collapsed, and unique by their compatibility-normalized lower case", () => {
  assert.equal(tagDisplayLabel("  出差  台中 "), "出差 台中");
  assert.equal(normalizeTagLabel("出差　台中"), normalizeTagLabel("出差 台中"), "a full-width space is a space");
  assert.equal(normalizeTagLabel("Ｔrip"), normalizeTagLabel("trip"), "a full-width letter and case fold together");
  assert.equal(tagLabelProblem("   "), "empty");
  assert.equal(tagLabelProblem("字".repeat(41)), "too_long");
  assert.equal(tagLabelProblem("字".repeat(40)), null);
});

test("a blank note is no note, and a note has at most 500 characters", () => {
  assert.equal(noteText("  "), null);
  assert.equal(noteText(" 午餐 "), "午餐");
  assert.equal(noteProblem("長".repeat(500)), null);
  assert.equal(noteProblem("長".repeat(501)), "too_long");
  assert.equal(noteProblem(null), null);
});
