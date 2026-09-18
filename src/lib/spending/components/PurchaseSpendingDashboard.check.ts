import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PurchaseSpendingDashboard.svelte", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("./PurchaseActivityBarChart.svelte", import.meta.url), "utf8");
const matchingSource = readFileSync(new URL("../purchase-matching.ts", import.meta.url), "utf8");
const entry = readFileSync(new URL("../SpendingDashboard.svelte", import.meta.url), "utf8");

assert.match(entry, /spending\.purchaseReport/);
assert.match(entry, /<PurchaseSpendingDashboard/);
assert.doesNotMatch(entry, /similarity.*exclu/iu);

for (const marker of [
  "購買行為",
  "含待確認項目",
  "可能重複",
  "確認配對",
  "否認候選",
  "撤銷配對",
  "以入帳日期代替",
  "退款依退款發生月份認列",
  "來源與配對證據",
  "來源金額不同，未推算費用",
  "未分類",
  "金額未提供",
  "配對付款",
  "選擇付款交易",
  "可配對的付款交易",
  "你可以選擇不同月份、金額或幣別的付款",
  "金額與幣別採銀行付款",
  "日期採發票購買日",
  "信用卡消費",
  "銀行交易",
]) assert.match(source, new RegExp(marker));

assert.match(source, /window\.octopusBeak\.spending\.confirmCandidate/);
assert.match(source, /window\.octopusBeak\.spending\.denyCandidate/);
assert.match(source, /window\.octopusBeak\.spending\.revokeLink/);
assert.match(source, /applyValidatedSpendingActionResult\(report, result\)/);
assert.doesNotMatch(source, /next\.purchaseReport/);
assert.match(source, /data-pending-total/);
assert.match(source, /data-link-difference/);
assert.match(source, /data-item-details/);
assert.match(source, /role="dialog"/);
assert.match(source, /kind: "direct"/);
assert.match(source, /idempotencyKey/);
assert.match(source, /beginSpendingPendingCommand/);
assert.match(source, /completeSpendingPendingCommand/);
assert.match(source, /spending-pair-stale/);
assert.match(source, /idempotency-key-conflict/);
assert.match(source, /讀取中/);
assert.match(source, /onActionReconciliation/);
assert.match(source, /invoiceIdentityId/);
assert.match(source, /transactionIdentityId/);
assert.match(source, /slice\(0, paymentVisibleCount\)/);
assert.match(source, /data-show-more-payments/);
assert.match(source, /paymentVisibleCount \+= 10/);
assert.match(source, /candidateVisibleCount = 10/);
assert.match(source, /slice\(0, candidateVisibleCount\)/);
assert.match(source, /data-show-more-candidates/);
assert.match(source, /candidateVisibleCount \+ 10/);
assert.match(source, /candidateVisibleCount = Math\.min\(10, visibleCandidates\.length\)/);
assert.match(source, /<PurchaseActivityBarChart/);
assert.match(source, /dailyChartData\(/);
assert.match(source, /monthlyChartData\(/);
assert.match(source, /data-purchase-day/);
assert.match(source, /selectedDay === key/);
assert.match(source, /selectChartPeriodFromControl/);
assert.match(source, /選擇日期以篩選購買明細/);
assert.match(source, /<option value="">.*顯示整月/);
assert.match(source, /showAllCandidates/);
assert.match(source, /只看本月/);
assert.match(source, /查看全部/);
assert.match(source, /這個期間沒有消費/);
assert.match(chartSource, /import \{ BarChart, defaultChartPadding \} from "layerchart"/);
assert.match(chartSource, /onBarClick=\{selectBar\}/);
assert.match(chartSource, /cRange=\{\["var\(--accent\)", "var\(--danger\)"\]\}/);
assert.match(source, /rankSpendingManualPaymentCandidates/);
assert.match(source, /basisLabel\(payment\)/);
assert.match(source, /from "\.\.\/purchase-matching\.ts"/);
assert.doesNotMatch(source, /ledger\/canonical\/|node:/u);
assert.doesNotMatch(matchingSource, /from ["']node:/u);
assert.doesNotMatch(matchingSource, /from ["'][^"']*(?:canonical|server)[^"']*["']/u);
