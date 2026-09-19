import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./FinancialSecondaryFallback.svelte", import.meta.url), "utf8");

test("secondary fallback renders actual values for every financial route", () => {
  assert.match(source, /<DailyHistoryTable rows=\{overview\.dailyHistory\}/);
  assert.match(source, /<OverviewSankeyCard/);
  assert.match(source, /<DailyHistoryTable rows=\{assets\.dailyHistory\}/);
  assert.match(source, /<DailyHistoryTable rows=\{liabilities\.dailyHistory\}/);
  assert.match(source, /spending\.purchaseReport\.records as record/);
  assert.match(source, /record\.occurrence\.value/);
  assert.match(source, /amountText\(record\.amount\)/);
  assert.match(source, /spending-display\.ts/);
  assert.match(source, /spendingAmountText\(/);
  assert.match(source, /spendingBasisLabel\(/);
  assert.match(source, /spendingRecordLabel\(/);
  assert.match(source, /data-secondary-knowledge-point=\{data\.knowledgePoint\}/);
  assert.match(source, /data-secondary-ready/);
});

test("spending secondary fallback is explicitly read-only", () => {
  assert.match(source, /主要資料目前無法載入，因此此區僅供檢視/);
  assert.doesNotMatch(source, /confirmCandidate|revokeLink|confirmDirectPair|data-open-pairing/);
  assert.doesNotMatch(source, /<button/);
});
