import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import { translateSummaryBreakdown } from "./summary-breakdown.ts";

const breakdown = ["Foreign", "Bank", "Bank", "Credit card", "Bank", "Other"];

test("repeated account kinds collapse into translated counts in first-seen order", () => {
  assert.deepEqual(translateSummaryBreakdown(breakdown, translations.en), [
    "Foreign 1",
    "Bank 3",
    "Credit Card 1",
    "Other 1",
  ]);
  assert.deepEqual(translateSummaryBreakdown(breakdown, translations["zh-TW"]), [
    "1 個外幣",
    "3 個銀行",
    "1 個信用卡",
    "1 個其他",
  ]);
});

test("account totals translate without grouping", () => {
  assert.deepEqual(
    translateSummaryBreakdown(["4 asset accounts", "2 debt accounts"], translations["zh-TW"]),
    [translations["zh-TW"].common.assetAccountCount(4), translations["zh-TW"].common.debtAccountCount(2)],
  );
});
