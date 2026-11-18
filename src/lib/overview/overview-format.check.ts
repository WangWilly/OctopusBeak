import assert from "node:assert/strict";
import test from "node:test";
import { formatPct, formatShare, formatShortDate, maskedAccountDigits } from "./overview-format.ts";
import { formatTwdNumber } from "../shared-money/money.ts";

test("an account label shows only the last four digits of its provider number", () => {
  assert.equal(maskedAccountDigits("Taipei Fubon Bank · Loan · LN-12-7730"), "7730");
  assert.equal(maskedAccountDigits("E.SUN Bank · Credit card account · ****5512"), "5512");
  assert.equal(maskedAccountDigits("Taipei Fubon Bank · Loan · LN-12-7730 · 2"), "7730", "the duplicate ordinal is not part of the number");
  assert.equal(maskedAccountDigits("Taipei Fubon Bank · Loan · Account 1"), null, "a placeholder has no digits to show");
});

test("signed figures use a true minus and hide the sign of zero", () => {
  assert.equal(formatTwdNumber(-19410.4, "zh-TW", true), "−19,410");
  assert.equal(formatTwdNumber(1860, "en", true), "+1,860");
  assert.equal(formatTwdNumber(0.2, "en", true), "0");
  assert.equal(formatPct(-0.024, "en"), "−2.4%");
  assert.equal(formatPct(0.003, "zh-TW"), "+0.3%");
  assert.equal(formatPct(0.00001, "en"), "0.0%");
});

test("short dates follow the interface language", () => {
  assert.equal(formatShortDate("2026-10-04", "zh-TW"), "10/4");
  assert.equal(formatShortDate("2026-10-04", "en"), "Oct 4");
});

test("a positive share too small for one decimal never reads as 0.0%", () => {
  assert.equal(formatShare(0.0000016, "zh-TW"), "<0.1%");
  assert.equal(formatShare(0.0005, "zh-TW"), "0.1%");
  assert.equal(formatShare(0.416, "en"), "41.6%");
});
