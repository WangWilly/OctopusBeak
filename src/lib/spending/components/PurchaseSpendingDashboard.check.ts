import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PurchaseSpendingDashboard.svelte", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("./PurchaseActivityBarChart.svelte", import.meta.url), "utf8");
const dictionarySource = readFileSync(new URL("../../i18n/i18n.ts", import.meta.url), "utf8");
const matchingSource = readFileSync(new URL("../purchase-matching.ts", import.meta.url), "utf8");
const entry = readFileSync(new URL("../SpendingDashboard.svelte", import.meta.url), "utf8");

assert.match(entry, /spending\.purchaseReport/);
assert.match(entry, /<PurchaseSpendingDashboard/);
assert.doesNotMatch(entry, /similarity.*exclu/iu);

// Both headline amounts must use the selected month's report slice, not the
// all-period purchaseReport totals supplied by the progressive block.
assert.match(source, /sideValue=\{visibleTotals\.length > 0/);
assert.match(source, /<strong class="money" data-sensitive>\{amountText\(selectedMonthTotal\)\}<\/strong>/);
assert.doesNotMatch(source, /summaryBlock\.purchaseReport\.totalsByCurrency\[0\]/);
assert.match(source, /sideLabel=\{\$t\.purchaseSpending\.monthlyTotal\}/);
assert.doesNotMatch(source, /\$locale === "zh-TW"/);
assert.doesNotMatch(chartSource, /\$locale === "zh-TW"/);

for (const marker of [
  "當月消費合計",
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
]) assert.match(dictionarySource, new RegExp(marker));

// The mounted session owns asynchronous lifecycle work; this component keeps
// the presentation boundary and sends intents through its narrow interface.
assert.match(source, /createPurchaseSpendingSession\(/);
assert.match(source, /createDesktopPurchaseSpendingTransport\(\)/);
assert.match(source, /spendingSession\.start\(\)/);
assert.match(source, /spendingSession\.dispose\(\)/);
assert.match(source, /spendingSession\.receiveLive\(purchaseReport, fallbackCanonical\)/);
assert.doesNotMatch(source, /window\.octopusBeak\.spending\./);
assert.match(source, /data-pending-total/);
assert.match(source, /data-link-difference/);
assert.match(source, /data-item-details/);
assert.match(source, /role="dialog"/);
assert.match(source, /slice\(0, paymentVisibleCount\)/);
assert.match(source, /data-show-more-payments/);
assert.match(source, /showMorePayments/);
assert.match(source, /slice\(0, candidateVisibleCount\)/);
assert.match(source, /data-show-more-candidates/);
assert.match(source, /<PurchaseActivityBarChart/);
assert.match(source, /dailyChartData\(/);
assert.match(source, /monthlyChartData\(/);
assert.match(source, /data-purchase-day/);
assert.match(source, /spendingSession\.chooseDay\(selectedDay === key \? null : key\)/);
assert.match(source, /selectChartPeriodFromControl/);
assert.match(dictionarySource, /選擇日期以篩選購買明細/);
assert.match(source, /<option value="">\{\$t\.purchaseSpending\.showFullMonth\}/);
assert.doesNotMatch(source, /showAllCandidates/);
assert.doesNotMatch(source, /viewAllCount/);
assert.match(source, /purchaseListView\(listReport, activeMonth, candidateVisibleCount\)/);
assert.match(source, /data-total-candidate-count=\{pairingCandidateTotal\}/);
assert.match(dictionarySource, /只看本月/);
assert.match(dictionarySource, /查看全部/);
assert.match(dictionarySource, /這個期間沒有消費/);
assert.match(chartSource, /import \{ BarChart, defaultChartPadding \} from "layerchart"/);
assert.match(chartSource, /onBarClick=\{selectBar\}/);
assert.match(chartSource, /cRange=\{\["var\(--accent\)", "var\(--danger\)"\]\}/);
assert.match(source, /data-pairing-feedback="open-dialog"/);
assert.match(source, /data-pairing-feedback="confirm-busy"/);
assert.match(source, /pairingCandidates: readonly SpendingPairingCandidateView\[\] \| null/);
assert.match(source, /pairingBasisLabel\(payment\)/);
assert.match(source, /from "\.\.\/purchase-matching\.ts"/);
assert.doesNotMatch(source, /ledger\/canonical\/|node:/u);
assert.doesNotMatch(matchingSource, /from ["']node:/u);
assert.doesNotMatch(matchingSource, /from ["'][^"']*(?:canonical|server)[^"']*["']/u);
