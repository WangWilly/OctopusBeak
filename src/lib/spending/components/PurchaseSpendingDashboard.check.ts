import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PurchaseSpendingDashboard.svelte", import.meta.url), "utf8");
const paceSource = readFileSync(new URL("./MonthPaceChart.svelte", import.meta.url), "utf8");
const trendSource = readFileSync(new URL("./MonthTrendChart.svelte", import.meta.url), "utf8");
const mergeSource = readFileSync(new URL("./SpendingMergeModal.svelte", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./SpendingPurchaseModal.svelte", import.meta.url), "utf8");
const chartSources = [["pace", paceSource], ["trend", trendSource]] as const;
const dictionarySource = readFileSync(new URL("../../i18n/i18n.ts", import.meta.url), "utf8");
const matchingSource = readFileSync(new URL("../purchase-matching.ts", import.meta.url), "utf8");
const entry = readFileSync(new URL("../SpendingDashboard.svelte", import.meta.url), "utf8");

assert.match(entry, /spending\.purchaseReport/);
assert.match(entry, /<PurchaseSpendingDashboard/);
assert.doesNotMatch(entry, /similarity.*exclu/iu);
// An empty page is still the purchase page; each card reads its own empty state.
assert.doesNotMatch(entry, /isEmptySpendingPage/);
assert.match(source, /readSpendingCards\(report\.summary, \{ month: activeMonth, today \}\)/);

// Both headline amounts must use the selected month's report slice, not the
// all-period purchaseReport totals supplied by the progressive block, and a
// selected day must not replace the month figure.
assert.match(source, /sideValue=\{visibleTotals\.length > 0/);
assert.match(source, /\$: visibleTotals = totalsForMonth\(report, activeMonth\);/);
assert.match(source, /\$: monthFigure = current\?\.total \?\? visibleTotals\.find/);
assert.match(source, /<strong class="money" data-sensitive>\{amountText\(monthFigure\)\}<\/strong>/);
assert.doesNotMatch(source, /summaryBlock\.purchaseReport\.totalsByCurrency\[0\]/);
assert.match(source, /sideLabel=\{\$t\.purchaseSpending\.monthlyTotal\}/);
assert.doesNotMatch(source, /\$locale === "zh-TW"/);
for (const [, chart] of chartSources) assert.doesNotMatch(chart, /\$locale ===/);

for (const marker of [
  "當月消費合計",
  "含待確認項目",
  "可能重複",
  "確認配對",
  "不是同一筆",
  "取消合併",
  "以入帳日期代替",
  "退款依退款發生月份認列",
  "合併所有高度相符",
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
assert.match(source, /role="dialog"/);
assert.match(source, /slice\(0, paymentVisibleCount\)/);
assert.match(source, /data-show-more-payments/);
assert.match(source, /showMorePayments/);
// The month reading and the bounded trend come from the pure insights module.
assert.match(source, /<MonthPaceChart reading=\{current\} span=\{reading\.span\} \{selectedDay\} onSelectDay=\{chooseDay\} \/>/);
assert.match(source, /<MonthTrendChart months=\{trend\} selectedMonth=\{reading\.month\} onSelectMonth=\{chooseMonth\} \/>/);
assert.match(source, /readSpendingMonth\(report\.summary, \{ month: activeMonth, today \}\)/);
assert.match(source, /readSpendingTrend\(report\.summary, \{ currency: selectedCurrency, selectedMonth: reading\.month, today \}\)/);
assert.match(source, /const today = taipeiDateKey\(Date\.now\(\) \/ 1000\);/);
assert.doesNotMatch(source, /chartMode|monthlyChartData|dailyChartData|PurchaseActivityBarChart/);
assert.match(source, /data-purchase-day/);
assert.match(source, /dayTotalsFor\(reading, group\.date, group\.totals\)/);
assert.match(source, /spendingSession\.chooseDay\(selectedDay === key \? null : key\)/);
assert.match(source, /onchange=\{\(event\) => spendingSession\.chooseDay\(event\.currentTarget\.value \|\| null\)\}/);
assert.match(dictionarySource, /選擇日期以篩選購買明細/);
assert.match(source, /<option value="">\{\$t\.purchaseSpending\.showFullMonth\}/);
assert.doesNotMatch(source, /showAllCandidates/);
assert.doesNotMatch(source, /viewAllCount/);
// Spending v2 page A: the month reading, category shares, projection and the
// global pending count come from the pure insights module and the review store.
assert.match(source, /readCategoryBreakdown\(report\.summary\.categoryTotalsByMonth, \{ month: reading\.month, currency: selectedCurrency \}\)/);
assert.match(source, /projectMonthEnd\(current, reading\.span\)/);
assert.match(source, /readTrendStats\(trend\)/);
assert.match(source, /review\.sync\(report\.knowledgeAt, activeMonth\)/);
assert.match(source, /slot="topbar-leading"/);
assert.match(source, /spendingSession\.setRecordFilter\(/);
assert.doesNotMatch(source, /data-candidates|candidateVisibleCount|purchase-basis-banner/);
// Modal B: 待合併 and 已合併 only (no 可能重複 or 退款 tab), 稍後處理 only closes,
// and the bulk merge goes through the strong-set command.
assert.match(source, /<SpendingMergeModal/);
assert.deepEqual([...mergeSource.matchAll(/data-merge-tab="([a-z]+)"/g)].map((match) => match[1]), ["pending", "merged"]);
assert.match(mergeSource, /data-merge-later onclick=\{onClose\}/);
assert.match(mergeSource, /review\.confirmStrong\(\)/);
assert.match(mergeSource, /review\.showMergeLists\(\)/);
assert.doesNotMatch(mergeSource, /可能重複|退款|possibleDuplicate|refund/);
assert.doesNotMatch(mergeSource, /\$locale ===/);
// Modals C/D: link differences and invoice items moved from the row into the
// detail modal; no 可能重複 warning and no 帳單號碼相符 chip exist to show.
assert.match(source, /<SpendingPurchaseModal/);
assert.match(detailSource, /data-link-difference/);
assert.match(detailSource, /data-item-details/);
assert.match(detailSource, /review\.setPurchaseCategory\(record\.purchaseId, code\)/);
assert.match(detailSource, /chooseCategory\(null\)/);
assert.match(detailSource, /data-open-pairing onclick=\{\(\) => onOpenPairing\(record\)\}/);
assert.doesNotMatch(detailSource, /可能重複|帳單號碼/);
assert.doesNotMatch(detailSource, /\$locale ===/);
assert.match(source, /data-total-candidate-count=\{pairingCandidateTotal\}/);
assert.match(dictionarySource, /查看全部/);
assert.match(dictionarySource, /這個期間沒有消費/);
assert.match(paceSource, /import \{ Area, AreaChart, BarChart, Bars, Points, Rule, Spline, Tooltip \} from "layerchart"/);
assert.match(trendSource, /import \{ BarChart, Bars, Tooltip \} from "layerchart"/);
// Tooltip hit areas sit above the bars, so selection must go through them.
assert.match(paceSource, /tooltipContext=\{\{ mode: "band", onclick: selectDay \}\}/);
assert.match(trendSource, /tooltipContext=\{\{ mode: "band", onclick: selectMonth \}\}/);
assert.match(paceSource, /cDomain=\{\["spend", "heavy", "refund", "quiet", "future"\]\}/);
assert.match(paceSource, /cRange=\{\["color-mix\(in oklch, var\(--accent\) 55%, transparent\)", "var\(--accent\)", "var\(--danger\)", "transparent", "transparent"\]\}/);
assert.match(source, /data-pairing-feedback="open-dialog"/);
assert.match(source, /data-pairing-feedback="confirm-busy"/);
assert.match(source, /pairingCandidates: readonly SpendingPairingCandidateView\[\] \| null/);
assert.match(source, /pairingBasisLabel\(payment\)/);
assert.match(source, /from "\.\.\/purchase-matching\.ts"/);
assert.doesNotMatch(source, /ledger\/canonical\/|node:/u);
assert.doesNotMatch(matchingSource, /from ["']node:/u);
assert.doesNotMatch(matchingSource, /from ["'][^"']*(?:canonical|server)[^"']*["']/u);

for (const [name, component] of [["purchase", source], ["merge", mergeSource], ["detail", detailSource], ...chartSources] as const) {
  const markup = component.slice(component.indexOf("</script>"), component.indexOf("<style>"));
  for (const match of markup.matchAll(/\{[^{}]*(?:amountText|AmountText)\b[^{}]*\}/g)) {
    const before = markup.slice(0, match.index);
    if (/sideValue=$/.test(before)) continue;
    assert.match(before, /<(?:span|strong) class="(?:[\w-]+ )*money(?: [\w-]+)*" data-sensitive>$/, `${name} amount must blur when values are hidden: ${match[0]}`);
  }
}
assert.doesNotMatch(source, /<option value=\{datum\.key\}>[^<]*datum\.value/);
for (const [name, chart] of chartSources) {
  const yAxes = chart.match(/yAxis: \{/g)?.length ?? 0;
  assert.ok(yAxes > 0, `${name} chart draws a y axis`);
  assert.equal(chart.match(/tickLabelProps: \{ "data-sensitive": "" \}/g)?.length, yAxes, `${name} y ticks blur when values are hidden`);
  const tooltips = chart.match(/<Tooltip\.Root /g)?.length ?? 0;
  assert.ok(tooltips > 0, `${name} chart has a tooltip`);
  assert.equal(chart.match(/<Tooltip\.Root \{context\} class="sparkline-tooltip" variant="none" portal=\{false\}>/g)?.length, tooltips, `${name} tooltips stay inside the chart`);
  assert.match(chart, /<ul class="chart-data-summary" aria-label=/, `${name} chart keeps a screen-reader summary`);
}
