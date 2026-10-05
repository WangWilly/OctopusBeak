<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowRight, ChevronLeft, ChevronRight, GitMerge, Link, Search, TrendingUp } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";
  import { resolveSpendingPurchaseReport } from "$lib/shared-shell/progressive-dashboard-data.ts";
  import {
    type SpendingPurchaseRecordView as PurchaseRecord,
  } from "../purchase-matching.ts";
  import {
    taipeiDateKey,
    type SpendingCandidatePairRef,
    type SpendingPageDto,
    type SpendingPairingCandidateView,
  } from "../model.ts";
  import {
    createDesktopPurchaseSpendingTransport,
    createPurchaseSpendingSession,
    type PurchaseSpendingFeedback,
    type PurchaseSpendingReport,
  } from "../purchase-spending-session.ts";
  import {
    createDesktopSpendingReviewTransport,
    createSpendingReviewStore,
  } from "../spending-review-store.ts";
  import {
    projectMonthEnd,
    readCategoryBreakdown,
    readSpendingMonth,
    readSpendingTrend,
    readTrendStats,
    type CategoryBreakdownKey,
    type CurrencyCode,
    type MonthReading,
  } from "../spending-insights.ts";
  import {
    SPENDING_GROUP_COLORS,
    dayHeadingText,
    groupLabel,
    monthDayText,
    monthText,
    paymentMethodText,
    recordCategoryText,
    recordGroups,
    recordMerchant,
    shareText,
    shortMonthText,
  } from "../spending-display.ts";
  import MonthPaceChart from "./MonthPaceChart.svelte";
  import MonthTrendChart from "./MonthTrendChart.svelte";
  import SpendingMergeModal from "./SpendingMergeModal.svelte";
  import SpendingPurchaseModal from "./SpendingPurchaseModal.svelte";
  import { moneyText, type ExactMoney } from "./money-text.ts";

  type PurchaseReport = PurchaseSpendingReport;

  export let purchaseReport: PurchaseReport;
  export let fallbackCanonical: SpendingPageDto["canonical"];
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let refreshSummary: () => Promise<void> = async () => {};
  const spendingSession = createPurchaseSpendingSession({
    report: purchaseReport,
    canonical: fallbackCanonical,
    refreshSummary: () => refreshSummary(),
    transport: createDesktopPurchaseSpendingTransport(),
  });
  const spendingState = spendingSession.state;
  const review = createSpendingReviewStore({
    transport: createDesktopSpendingReviewTransport(),
    refreshSummary: () => refreshSummary(),
  });
  const reviewState = review.state;

  export let retryBlock: (key: string) => void = () => {};

  function blockState(key: "summary" | "chart" | "details"): BlockState<DashboardBlockPayload> {
    if (report.summary) {
      const data = {
        canonical: $spendingState.canonical,
        purchaseReport: report as unknown as SpendingPageDto["purchaseReport"],
        invoices: [],
      };
      return {
        status: "ready",
        data: { route: "spending", block: key, data } as DashboardBlockPayload,
      };
    }
    return blocks[key] ?? { status: "loading" };
  }

  function spendingBlockData(
    key: "summary" | "chart" | "details",
    payload: DashboardBlockPayload | undefined,
  ) {
    return payload?.route === "spending" && payload.block === key ? payload.data : undefined;
  }

  let report = purchaseReport;
  let isUpdating = false;
  let canonical = fallbackCanonical;
  let previousReport = purchaseReport;
  let previousCanonical = fallbackCanonical;
  let selectedMonth: string | null = null;
  let chartReady = false;
  const today = taipeiDateKey(Date.now() / 1000);
  let selectedCurrency = "";
  let selectedDay: string | null = null;
  let busyAction: string | null = null;
  let actionError: PurchaseSpendingFeedback | null = null;
  let pairingFeedback: "selectionUnavailable" | "" = "";
  let pairingInvoice: PurchaseRecord | null = null;
  let selectedPaymentId = "";
  let paymentVisibleCount = 10;
  let monthCandidateCount: number | null = null;
  let recordPageLoading = false;
  let hasMoreRecords = false;
  let pairingCandidates: readonly SpendingPairingCandidateView[] | null = null;
  let validatedSelectedCandidate: SpendingPairingCandidateView | null = null;
  let pairingCandidateTotal = 0;
  let pairingCandidatesLoading = false;
  let pageError = "";
  let searchText = "";
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let mergeTab: "pending" | "merged" | null = null;
  let detailRecord: PurchaseRecord | null = null;
  const reportDerivedCache = new WeakMap<object, {
    months: readonly string[];
    availableCurrencies: readonly string[];
  }>();

  $: report = $spendingState.report;
  $: isUpdating = $spendingState.isUpdating;
  $: canonical = $spendingState.canonical;
  $: selectedMonth = $spendingState.selectedMonth;
  $: selectedDay = $spendingState.selectedDay;
  $: recordFilter = $spendingState.recordFilter;
  $: busyAction = $spendingState.busyAction;
  $: actionError = $spendingState.actionError;
  $: pageError = $spendingState.pageError;
  $: pairingFeedback = $spendingState.pairingFeedback;
  $: pairingInvoice = $spendingState.pairingInvoice;
  $: selectedPaymentId = $spendingState.selectedPaymentId;
  $: paymentVisibleCount = $spendingState.paymentVisibleCount;
  $: monthCandidateCount = $spendingState.monthCandidateCount;
  $: recordPageLoading = $spendingState.recordPageLoading;
  $: hasMoreRecords = $spendingState.hasMoreRecords;
  $: pairingCandidates = $spendingState.pairingCandidates;
  $: validatedSelectedCandidate = $spendingState.validatedSelectedCandidate;
  $: pairingCandidateTotal = $spendingState.pairingCandidateTotal;
  $: pairingCandidatesLoading = $spendingState.pairingCandidatesLoading;

  onMount(() => {
    spendingSession.start();
    let firstFrame = 0;
    let chartFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      chartFrame = requestAnimationFrame(() => {
        chartReady = true;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(chartFrame);
      if (searchTimer !== null) clearTimeout(searchTimer);
      spendingSession.dispose();
      review.dispose();
    };
  });

  function reportDerivedFor(sourceReport: PurchaseReport) {
    const cached = reportDerivedCache.get(sourceReport);
    if (cached) return cached;
    const derived = {
      months: monthsForReport(sourceReport),
      availableCurrencies: currenciesForReport(sourceReport),
    };
    reportDerivedCache.set(sourceReport, derived);
    return derived;
  }

  $: if (purchaseReport !== previousReport || fallbackCanonical !== previousCanonical) {
    previousReport = purchaseReport;
    previousCanonical = fallbackCanonical;
    spendingSession.receiveLive(purchaseReport, fallbackCanonical);
  }
  $: actionErrorText = actionError
    ? actionError.kind === "error"
      ? actionError.message
      : actionError.key === "pairingSelectionUnavailable"
        ? $t.purchaseSpending.pairingSelectionUnavailable
        : actionError.key === "pairingDataChanged"
          ? $t.purchaseSpending.pairingDataChanged
          : $t.purchaseSpending.pairingInvoiceUnavailable
    : "";
  $: pairingFeedbackText = pairingFeedback === "selectionUnavailable"
    ? $t.purchaseSpending.pairingSelectionUnavailable
    : "";
  $: reportDerived = reportDerivedFor(report);
  $: months = reportDerived.months;
  $: activeMonth = selectedMonth ?? months.at(-1) ?? null;
  $: if (report.summary) review.sync(report.knowledgeAt, activeMonth);
  $: availableCurrencies = reportDerived.availableCurrencies;
  $: if (!selectedCurrency || !availableCurrencies.includes(selectedCurrency)) selectedCurrency = availableCurrencies[0] ?? "TWD";
  $: visibleEligiblePayments = [
    ...(validatedSelectedCandidate && selectedPaymentId === validatedSelectedCandidate.transactionId &&
      !(pairingCandidates ?? []).slice(0, paymentVisibleCount).some((candidate) => candidate.transactionId === selectedPaymentId)
      ? [validatedSelectedCandidate] : []),
    ...(pairingCandidates ?? []).slice(0, paymentVisibleCount),
  ];
  $: selectedPayment = pairingCandidates?.find((candidate) => candidate.transactionId === selectedPaymentId)
    ?? (validatedSelectedCandidate?.transactionId === selectedPaymentId ? validatedSelectedCandidate : null);
  $: visibleTotals = totalsForMonth(report, activeMonth);
  $: monthSummary = report.summary?.monthTotals.find((summary) => summary.month === activeMonth) ?? null;
  $: periodRecordCount = report.summary
    ? selectedDay
      ? report.summary.dayTotals.find((summary) => summary.date === selectedDay)?.recordCount ?? 0
      : monthSummary?.recordCount ?? 0
    : 0;
  $: reading = report.summary ? readSpendingMonth(report.summary, { month: activeMonth, today }) : null;
  $: current = reading?.byCurrency.get(selectedCurrency as CurrencyCode) ?? null;
  $: monthFigure = current?.total ?? visibleTotals.find((amount) => amount.currency === selectedCurrency) ?? null;
  $: trend = reading && report.summary
    ? readSpendingTrend(report.summary, { currency: selectedCurrency, selectedMonth: reading.month, today })
    : [];
  $: trendStats = readTrendStats(trend);
  $: projection = reading && current ? projectMonthEnd(current, reading.span) : null;
  $: breakdown = reading && report.summary
    ? readCategoryBreakdown(report.summary.categoryTotalsByMonth, { month: reading.month, currency: selectedCurrency })
    : [];
  $: largest = $reviewState.monthInsight?.month === reading?.month
    ? $reviewState.monthInsight?.largestByCurrency.find((entry) => entry.amount.currency === selectedCurrency) ?? null
    : undefined;
  $: pendingOverviewCount = $reviewState.overview?.pendingCount ?? null;
  $: selectedDayReading = current?.days.find((day) => day.date === selectedDay) ?? null;
  $: activeMonthIndex = activeMonth ? months.indexOf(activeMonth) : -1;
  $: previousMonthKey = activeMonthIndex > 0 ? months[activeMonthIndex - 1] : null;
  $: nextMonthKey = activeMonthIndex >= 0 ? months[activeMonthIndex + 1] ?? null : null;
  $: pendingAffectsTotal = reading
    ? reading.caveat.kind === "may-include-duplicates"
    : report.totalStatus === "includes-pending-confirmation";
  $: filterActive = recordFilter.group !== null || recordFilter.query !== "";
  $: liveRecords = visibleRecordsOf(report, activeMonthForReport(report, activeMonth), selectedDay);
  $: detailShown = detailRecord ? currentRecordFor(liveRecords, detailRecord) : null;
  $: detailIndex = detailShown ? liveRecords.findIndex((record) => record.purchaseId === detailShown.purchaseId) : -1;
  $: detailPendingItem = detailShown ? pendingItemFor(detailShown) : null;

  function amountText(amount: ExactMoney | null, signed = false) {
    if (!amount) return $t.purchaseSpending.amountUnavailable;
    return moneyText(amount, $locale, signed);
  }

  function absolute(amount: ExactMoney): ExactMoney {
    return { ...amount, coefficient: amount.coefficient.replace(/^-/u, "") };
  }

  function dayTotalsFor(sourceReading: MonthReading | null, date: string, loaded: readonly ExactMoney[]) {
    if (filterActive || !sourceReading || !date.startsWith(`${sourceReading.month}-`)) return loaded;
    const index = Number(date.slice(8, 10)) - 1;
    const exact = sourceReading.currencies.flatMap((currency) => {
      const day = sourceReading.byCurrency.get(currency)?.days[index];
      return day && day.tone !== "quiet" && day.tone !== "future" ? [day.net] : [];
    });
    return exact.length > 0 ? exact : loaded;
  }

  function chooseDay(key: string) {
    spendingSession.chooseDay(selectedDay === key ? null : key);
  }

  function dateText(value: string) {
    const date = value.slice(0, 10);
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? date
      : new Intl.DateTimeFormat($locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
  }

  function occurrenceBasisLabel(record: PurchaseRecord) {
    return record.occurrence.basis === "posting-date-fallback" ? $t.purchaseSpending.postingDateFallback : null;
  }

  function recordLabel(record: PurchaseRecord) {
    return recordMerchant($t, record);
  }

  function pairingRecordLabel(candidate: SpendingPairingCandidateView) {
    return candidate.description ?? $t.purchaseSpending.merchantUnavailable;
  }

  function pairingBasisLabel(candidate: SpendingPairingCandidateView) {
    return candidate.stream === "credit-card" ? $t.purchaseSpending.creditCardPurchase : $t.purchaseSpending.bankTransaction;
  }

  function exactText(value: { coefficient: string; scale: number } | null) {
    if (!value) return $t.purchaseSpending.unavailable;
    if (value.scale === 0) return value.coefficient;
    const negative = value.coefficient.startsWith("-");
    const digits = negative ? value.coefficient.slice(1) : value.coefficient;
    const padded = digits.padStart(value.scale + 1, "0");
    const split = padded.length - value.scale;
    return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`;
  }

  function monthsForReport(sourceReport: PurchaseReport) {
    return sourceReport.summary?.monthTotals.map((month) => month.month)
      ?? [...new Set(sourceReport.records.map((record) => record.occurrence.value.slice(0, 7)))].sort();
  }

  function activeMonthForReport(sourceReport: PurchaseReport, preferred: string | null) {
    const months = monthsForReport(sourceReport);
    return preferred && months.includes(preferred) ? preferred : months.at(-1) ?? null;
  }

  function currenciesForReport(sourceReport: PurchaseReport) {
    return sourceReport.summary?.currencies
      ?? [...new Set(sourceReport.records.flatMap((record) => record.amount ? [record.amount.currency] : []))].sort();
  }

  function totalsForMonth(sourceReport: PurchaseReport, month: string | null) {
    if (sourceReport.summary) return sourceReport.summary.monthTotals.find((row) => row.month === month)?.totalsByCurrency ?? [];
    return totalsByCurrency(sourceReport.records.filter((record) => month === null || record.occurrence.value.startsWith(`${month}-`)));
  }

  function totalsByCurrency(records: readonly PurchaseRecord[]) {
    const totals = new Map<string, { coefficient: string; scale: number; currency: string }>();
    for (const record of records) {
      if (!record.amount) continue;
      const previous = totals.get(record.amount.currency);
      if (!previous) {
        totals.set(record.amount.currency, { ...record.amount });
        continue;
      }
      const scale = Math.max(previous.scale, record.amount.scale);
      const coefficient = BigInt(previous.coefficient) * 10n ** BigInt(scale - previous.scale) +
        BigInt(record.amount.coefficient) * 10n ** BigInt(scale - record.amount.scale);
      totals.set(record.amount.currency, {
        currency: record.amount.currency,
        coefficient: coefficient.toString(),
        scale,
      });
    }
    return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
  }

  function visibleRecordsOf(sourceReport: PurchaseReport, month: string | null, day: string | null) {
    return sourceReport.records
      .filter((record) => (month === null || record.occurrence.value.startsWith(`${month}-`)) && (day === null || record.occurrence.value.startsWith(day)))
      .slice()
      .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
  }

  function currentRecordFor(records: readonly PurchaseRecord[], previous: PurchaseRecord) {
    return records.find((record) => record.purchaseId === previous.purchaseId)
      ?? records.find((record) => (previous.invoice && record.invoice?.invoiceId === previous.invoice.invoiceId)
        || (previous.transaction && record.transaction?.transactionId === previous.transaction.transactionId))
      ?? previous;
  }

  function pendingItemFor(record: PurchaseRecord) {
    const items = $spendingState.candidateItems.filter((item) => record.candidateIds.includes(item.candidate.candidateId));
    return items.find((item) => item.candidate.strength === "strong") ?? items[0] ?? null;
  }

  function stepPurchase(offset: -1 | 1) {
    const next = liveRecords[detailIndex + offset];
    if (next) detailRecord = next;
  }

  function groupRecordsByDate(records: readonly PurchaseRecord[]) {
    const groups = new Map<string, PurchaseRecord[]>();
    for (const record of records) {
      const date = record.occurrence.value.slice(0, 10);
      const group = groups.get(date) ?? [];
      group.push(record);
      groups.set(date, group);
    }
    return [...groups.entries()].map(([date, entries]) => ({
      date,
      records: entries,
      totals: totalsByCurrency(entries),
    }));
  }

  function chooseMonth(month: string) {
    searchText = "";
    spendingSession.chooseMonth(month);
  }

  function chooseGroup(group: CategoryBreakdownKey | null) {
    spendingSession.setRecordFilter({ group, query: recordFilter.query });
  }

  function searchRecords(value: string) {
    searchText = value;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      spendingSession.setRecordFilter({ group: recordFilter.group, query: searchText });
    }, 250);
  }

  function clearRecordFilter() {
    searchText = "";
    spendingSession.setRecordFilter({ group: null, query: "" });
  }

  function openPurchase(record: PurchaseRecord) {
    detailRecord = record;
  }

  function openPairing(record: PurchaseRecord) {
    spendingSession.openPairing(record);
  }

  function openMerge(tab: "pending" | "merged" = "pending") {
    detailRecord = null;
    mergeTab = tab;
  }

  function decidePair(pair: SpendingCandidatePairRef, action: "confirm" | "deny") {
    return action === "confirm" ? spendingSession.confirmCandidate(pair) : spendingSession.denyCandidate(pair);
  }

  function revokeLink(record: PurchaseRecord) {
    return spendingSession.revokeLink(record);
  }

  function closePairing() {
    spendingSession.closePairing();
  }

  function showMorePayments() {
    return spendingSession.showMorePayments();
  }

  function loadMoreRecords() {
    return spendingSession.loadMoreRecords();
  }

  function confirmDirectPair() {
    return spendingSession.confirmDirectPair();
  }
</script>

<DashboardShell
  active="spending"
  eyebrow={$t.spending.eyebrow}
  title={$t.spending.title}
  sideLabel={$t.purchaseSpending.monthlyTotal}
  sideValue={visibleTotals.length > 0 ? visibleTotals.map((amount) => amountText(amount)).join(" / ") : "--"}
  sideSub={pendingAffectsTotal ? $t.purchaseSpending.includesPending : $t.purchaseSpending.purchaseBasisTotal}
>
  <svelte:fragment slot="topbar-leading">
    {#if report.summary}
      <button
        type="button"
        class="merge-trigger"
        data-open-merge
        aria-label={pendingOverviewCount === null ? $t.spendingReview.mergeButton : $t.spendingReview.mergeButtonAria(pendingOverviewCount)}
        onclick={() => openMerge()}
      >
        <GitMerge size={15} strokeWidth={2} aria-hidden="true" />
        <span>{$t.spendingReview.mergeButton}</span>
        {#if pendingOverviewCount !== null && pendingOverviewCount > 0}<span class="merge-count num" data-pending-overview-count>{pendingOverviewCount}</span>{/if}
      </button>
    {/if}
  </svelte:fragment>

  <div class="content spending-dashboard purchase-spending" data-spending-canonical data-purchase-report>
    {#if recordPageLoading || isUpdating}
      <p class="visually-hidden" role="status" data-spending-updating>{$t.common.loading}</p>
    {/if}
    {#if actionErrorText || pageError}
      <section class="card purchase-action-error" role="alert">{actionErrorText || pageError}</section>
    {/if}

    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")} let:data>
      {@const summaryBlock = spendingBlockData("summary", data)}
      <section class="card month-overview" data-month-panel aria-labelledby="spending-month-title">
        <div class="month-summary">
          <header class="month-head">
            <div class="month-nav">
              <button type="button" class="icon-button" aria-label={$t.spendingInsight.previousMonth} disabled={!previousMonthKey} onclick={() => previousMonthKey && chooseMonth(previousMonthKey)}>
                <ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <h2 id="spending-month-title">{activeMonth ? monthText(activeMonth, $locale) : $t.purchaseSpending.allMonths}</h2>
              <button type="button" class="icon-button" aria-label={$t.spendingInsight.nextMonth} disabled={!nextMonthKey} onclick={() => nextMonthKey && chooseMonth(nextMonthKey)}>
                <ChevronRight size={16} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
            <div class="month-meta">
              {#if availableCurrencies.length > 1}
                <div class="filters currency-switch" role="group" aria-label={$t.purchaseSpending.chartCurrency}>
                  {#each availableCurrencies as currency}
                    <button type="button" class="filter-btn" aria-pressed={currency === selectedCurrency} onclick={() => selectedCurrency = currency}>{currency}</button>
                  {/each}
                </div>
              {/if}
              {#if reading}
                <span class="data-through">
                  {#if reading.latestRecordDate}
                    {reading.span.kind === "in-progress"
                      ? $t.spendingReview.dataThroughInProgress(monthDayText(reading.latestRecordDate), reading.span.throughDay, reading.span.daysInMonth)
                      : $t.spendingReview.dataThrough(monthDayText(reading.latestRecordDate))}
                  {:else if reading.span.kind === "in-progress"}
                    {$t.spendingInsight.throughDay(reading.span.throughDay, reading.span.daysInMonth)}
                  {/if}
                </span>
              {/if}
            </div>
          </header>

          <div class="month-figure">
            <span class="figure-label">{reading?.span.kind === "in-progress" ? $t.spendingReview.monthSpendingInProgress : $t.spendingReview.monthSpending}</span>
            <strong class="money" data-sensitive>{amountText(monthFigure)}</strong>
            {#if reading && current}
              {#if current.standing.kind === "no-usual"}
                <p class="month-standing muted">{$t.spendingInsight.usualNotYet(3 - (current.usual.kind === "unavailable" ? current.usual.fullMonthsAvailable : 0))}</p>
              {:else}
                {@const difference = current.standing.differenceFromMean}
                {@const direction = difference.coefficient.startsWith("-") ? $t.spendingReview.lessThanUsual : $t.spendingReview.moreThanUsual}
                <p class="month-standing" data-standing={current.standing.kind}>
                  <span class="standing-chip">
                    {#if current.standing.kind === "above"}<TrendingUp size={13} strokeWidth={2.2} aria-hidden="true" />{/if}
                    {reading.span.kind === "in-progress" ? $t.spendingInsight.standingToDate[current.standing.kind] : $t.spendingInsight.standing[current.standing.kind]}
                  </span>
                  {#if difference.coefficient !== "0"}
                    <span class="standing-difference">{direction.before} <span class="money" data-sensitive>{amountText(absolute(difference))}</span> {direction.after}</span>
                  {/if}
                  {#if current.usual.kind === "available"}
                    <span class="month-usual-range">
                      {reading.span.kind === "in-progress" ? $t.spendingReview.usualRangeToDate(reading.span.throughDay) : $t.spendingReview.usualRange}
                      <span class="money" data-sensitive>{amountText(current.usual.low)}</span>–<span class="money" data-sensitive>{amountText(current.usual.high)}</span>
                    </span>
                  {/if}
                </p>
              {/if}
            {/if}
          </div>

          {#if reading && current}
            <dl class="month-facts">
              <div>
                <dt>{$t.spendingReview.dailyMean}</dt>
                <dd><span class="money" data-sensitive>{amountText(current.dailyMean)}</span></dd>
                {#if current.usual.kind === "available"}<dd class="fact-sub">{$t.spendingReview.usualPrefix} <span class="money" data-sensitive>{amountText(current.usual.dailyMean)}</span></dd>{/if}
              </div>
              <div data-largest-purchase>
                <dt>{$t.spendingReview.largestPurchase}</dt>
                {#if largest}
                  <dd><span class="money" data-sensitive>{amountText(largest.amount)}</span></dd>
                  <dd class="fact-sub">{monthDayText(largest.occurrence)} · {largest.merchantLabel ?? $t.purchaseSpending.merchantUnavailable}</dd>
                {:else if largest === null}
                  <dd class="fact-empty">{$t.spendingReview.noPurchaseYet}</dd>
                {:else}
                  <dd class="fact-empty" aria-busy="true">—</dd>
                {/if}
              </div>
              <div
                class="pending-fact"
                data-pending-total={reading.caveat.kind === "may-include-duplicates" ? "" : undefined}
                data-total-status={reading.caveat.kind === "checking" ? "month-pending-unloaded" : reading.caveat.kind === "may-include-duplicates" ? "includes-pending-confirmation" : "complete"}
              >
                <dt>{$t.spendingReview.pendingPairs}</dt>
                {#if monthCandidateCount === null}
                  <dd class="fact-empty" role="status">{$t.spendingInsight.checkingDuplicates}</dd>
                {:else}
                  <dd class="num" class:accent={monthCandidateCount > 0}>{$t.spendingReview.pairsCount(monthCandidateCount)}</dd>
                  {#if monthCandidateCount > 0 || (pendingOverviewCount ?? 0) > 0}
                    <dd class="fact-sub"><button type="button" class="text-link" onclick={() => openMerge()}>{$t.spendingReview.openMerge}<ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" /></button></dd>
                  {/if}
                {/if}
              </div>
            </dl>
          {:else if reading}
            <p class="month-empty">{$t.spendingInsight.noCurrencyThisMonth(selectedCurrency)}</p>
          {:else if (summaryBlock?.purchaseReport.totalStatus ?? report.totalStatus) === "includes-pending-confirmation"}
            <p class="month-caveat" data-pending-total data-total-status="includes-pending-confirmation">{$t.purchaseSpending.pendingTotalNote}</p>
          {/if}
        </div>

        {#if reading}
          <section class="category-breakdown" aria-labelledby="spending-category-title" data-category-breakdown>
            <header>
              <h2 id="spending-category-title">{$t.spendingReview.categoryTitle}</h2>
              <span>{$t.spendingReview.categoryShare}</span>
            </header>
            {#if breakdown.length > 0}
              <div class="category-bar" aria-hidden="true">
                {#each breakdown.filter((row) => row.share > 0) as row (row.key)}
                  <span style:flex-grow={row.share} style:background={SPENDING_GROUP_COLORS[row.key]}></span>
                {/each}
              </div>
              <ul class="category-list">
                {#each breakdown as row (row.key)}
                  <li data-category-group={row.key}>
                    <span class="category-dot" style:background={SPENDING_GROUP_COLORS[row.key]} aria-hidden="true"></span>
                    <span class="category-name">{groupLabel($t, row.key)}</span>
                    <span class="category-share num" data-sensitive>{shareText(row.share, $locale)}</span>
                    <span class="money" data-sensitive>{amountText(row.amount)}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="category-empty">{$t.spendingReview.categoryEmpty}</p>
            {/if}
          </section>
        {/if}
      </section>
    </ProgressiveBlock>

    {#if reading}
      <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")}>
        <div class="charts-row">
          <section class="card pace-card" aria-labelledby="spending-pace-title">
            <header class="card-head">
              <div>
                <h2 id="spending-pace-title">{$t.spendingReview.paceTitle}</h2>
                <p>{$t.spendingReview.paceMeta}</p>
              </div>
              <ul class="pace-legend">
                <li><span class="legend-line" aria-hidden="true"></span>{$t.spendingInsight.seriesThisMonth}</li>
                {#if current?.usual.kind === "available"}
                  <li><span class="legend-dash" aria-hidden="true"></span>{$t.spendingInsight.seriesUsual}</li>
                  <li><span class="legend-band" aria-hidden="true"></span>{$t.spendingReview.seriesUsualRange}</li>
                {/if}
              </ul>
            </header>
            {#if current}
              {#if chartReady}
                <MonthPaceChart reading={current} span={reading.span} {selectedDay} onSelectDay={chooseDay} />
              {:else}
                <div class="month-chart-pending" aria-hidden="true"></div>
              {/if}
              {#if selectedDayReading}
                <div class="day-detail" data-day-detail>
                  <strong>{dateText(selectedDayReading.date)}</strong>
                  <span class="money" data-sensitive>{amountText(selectedDayReading.net)}</span>
                  <span>{$t.purchaseSpending.dayPurchasesCount(selectedDayReading.recordCount)}</span>
                  <button type="button" class="button secondary" onclick={() => spendingSession.chooseDay(null)}>{$t.purchaseSpending.showFullMonth}</button>
                </div>
              {/if}
              <div class="chart-footer">
                <label class="chart-period-picker">
                  <span>{$t.purchaseSpending.chooseDay}</span>
                  <select
                    aria-label={$t.purchaseSpending.chooseDayAria}
                    value={selectedDay ?? ""}
                    onchange={(event) => spendingSession.chooseDay(event.currentTarget.value || null)}
                  >
                    <option value="">{$t.purchaseSpending.showFullMonth}</option>
                    {#each current.days.filter((day) => day.tone !== "future") as day (day.date)}
                      <option value={day.date}>{monthDayText(day.date)}</option>
                    {/each}
                  </select>
                </label>
                {#if current.usual.kind === "available"}
                  <p class="chart-hint">{reading.span.kind === "in-progress"
                    ? $t.spendingInsight.usualBasisToDate(shortMonthText(current.usual.months[0], $locale), shortMonthText(current.usual.months[2], $locale), reading.span.throughDay)
                    : $t.spendingInsight.usualBasis(shortMonthText(current.usual.months[0], $locale), shortMonthText(current.usual.months[2], $locale))}</p>
                {/if}
              </div>
            {:else}
              <p class="month-empty">{$t.spendingInsight.noCurrencyThisMonth(selectedCurrency)}</p>
            {/if}
          </section>

          <section class="card trend-card" aria-labelledby="spending-trend-title">
            <header class="card-head">
              <div>
                <h2 id="spending-trend-title">{$t.spendingInsight.trendTitle}</h2>
                <p>{selectedCurrency}</p>
              </div>
            </header>
            {#if chartReady}
              <MonthTrendChart months={trend} selectedMonth={reading.month} onSelectMonth={chooseMonth} />
            {:else}
              <div class="trend-chart-pending" aria-hidden="true"></div>
            {/if}
            <dl class="trend-stats" data-trend-stats>
              {#if projection?.kind === "projected"}
                <div data-month-end-projection>
                  <dt>{$t.spendingReview.projection}<small>{$t.spendingReview.projectionBasis(projection.basisDays)}</small></dt>
                  <dd class="accent"><span aria-hidden="true">≈ </span><span class="money" data-sensitive>{amountText(projection.amount)}</span></dd>
                </div>
              {/if}
              {#if current?.usual.kind === "available"}
                <div>
                  <dt>{$t.spendingReview.usualMean}</dt>
                  <dd><span class="money" data-sensitive>{amountText(current.usual.fullMonthMean)}</span></dd>
                </div>
              {/if}
              <div>
                <dt>{$t.spendingReview.twelveMonthMean}</dt>
                <dd>{#if trendStats.monthlyMean}<span class="money" data-sensitive>{amountText(trendStats.monthlyMean)}</span>{:else}<span class="muted">{$t.spendingReview.notEnoughMonths}</span>{/if}</dd>
              </div>
              {#if trendStats.highest}
                <div>
                  <dt>{$t.spendingReview.highestMonth}<small>{monthText(trendStats.highest.month, $locale)}</small></dt>
                  <dd><span class="money" data-sensitive>{amountText(trendStats.highest.total)}</span></dd>
                </div>
              {/if}
            </dl>
          </section>
        </div>
      </ProgressiveBlock>
    {/if}

    <ProgressiveBlock label="details" state={blockState("details")} retry={() => retryBlock("details")} let:data>
    {@const detailsReport = report.summary ? report : resolveSpendingPurchaseReport(report, spendingBlockData("details", data))}
    {@const detailsActiveMonth = activeMonthForReport(detailsReport, activeMonth)}
    {@const detailsMonthRecords = detailsReport.records.filter((record) => detailsActiveMonth === null || record.occurrence.value.startsWith(`${detailsActiveMonth}-`))}
    {@const detailsVisibleRecords = detailsMonthRecords
      .filter((record) => selectedDay === null || record.occurrence.value.startsWith(selectedDay))
      .slice()
      .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId))}
    {@const detailsRecordGroups = groupRecordsByDate(detailsVisibleRecords)}
    <section class="card purchase-records-card" aria-labelledby="spending-records-title">
      <header class="records-head">
        <div class="records-title">
          <div>
            <h2 id="spending-records-title">{$t.purchaseSpending.purchases}</h2>
            <p>{$t.spendingReview.purchasesMeta(selectedDay ? dateText(selectedDay) : detailsActiveMonth ? monthText(detailsActiveMonth, $locale) : $t.purchaseSpending.allRecords, report.summary ? periodRecordCount : detailsVisibleRecords.length)}</p>
          </div>
          {#if selectedDay}<button type="button" class="button secondary" onclick={() => spendingSession.chooseDay(null)}>{$t.purchaseSpending.showFullMonth}</button>{/if}
          {#if report.summary}
            <label class="record-search">
              <Search size={15} strokeWidth={2} aria-hidden="true" />
              <input
                type="search"
                value={searchText}
                placeholder={$t.spendingReview.searchPlaceholder}
                aria-label={$t.spendingReview.searchAria}
                data-record-search
                oninput={(event) => searchRecords(event.currentTarget.value)}
              />
            </label>
          {/if}
        </div>
        {#if report.summary && breakdown.length > 0}
          <div class="filters category-filter" role="group" aria-label={$t.spendingReview.categoryFilterAria}>
            <button type="button" class="filter-btn" aria-pressed={recordFilter.group === null} onclick={() => chooseGroup(null)}>
              {$t.spendingReview.allCategories}<span class="chip-count num">{monthSummary?.recordCount ?? 0}</span>
            </button>
            {#each breakdown.filter((row) => row.count > 0) as row (row.key)}
              <button type="button" class="filter-btn" aria-pressed={recordFilter.group === row.key} data-category-filter={row.key} onclick={() => chooseGroup(row.key)}>
                <span class="category-dot" style:background={SPENDING_GROUP_COLORS[row.key]} aria-hidden="true"></span>{groupLabel($t, row.key)}<span class="chip-count num">{row.count}</span>
              </button>
            {/each}
          </div>
        {/if}
      </header>
      <div class="purchase-record-list">
        {#each detailsRecordGroups as group (group.date)}
          <section class="purchase-day-group" data-purchase-day={group.date}>
            <header class="purchase-day-heading">
              <strong>{dayHeadingText(group.date, $locale)}</strong>
              <span>{$t.purchaseSpending.recordsCount(group.records.length)}</span>
              <div class="day-totals">{#each dayTotalsFor(reading, group.date, group.totals) as total (total.currency)}<span class="money" data-sensitive>{amountText(total)}</span>{/each}</div>
            </header>
            {#each group.records as record (record.purchaseId)}
              {@const groups = recordGroups(record)}
              <button
                type="button"
                class="purchase-record"
                data-purchase-record
                data-basis={record.basis}
                data-transaction-id={record.transaction?.transactionId ?? ""}
                data-possible-duplicate={record.possibleDuplicate}
                aria-label={$t.spendingReview.openPurchase(recordLabel(record))}
                onclick={() => openPurchase(record)}
              >
                <span class="category-dot" style:background={SPENDING_GROUP_COLORS[groups[0] ?? "unclassified"]} aria-hidden="true"></span>
                <span class="record-texts">
                  <strong>{recordLabel(record)}</strong>
                  <span>{recordCategoryText($t, record)} · {paymentMethodText($t, record)}{#if occurrenceBasisLabel(record)}{" · "}<span class="fallback-date" data-date-basis="posting-date-fallback">{occurrenceBasisLabel(record)}</span>{/if}</span>
                </span>
                {#if record.basis === "linked"}
                  <span class="status-tag merged" data-status="merged"><Link size={12} strokeWidth={2.2} aria-hidden="true" />{$t.spendingReview.statusMerged}</span>
                {:else if record.possibleDuplicate}
                  <span class="status-tag pending" data-status="pending"><GitMerge size={12} strokeWidth={2.2} aria-hidden="true" />{$t.spendingReview.statusPending}</span>
                {/if}
                <strong class="record-amount money" data-sensitive>{amountText(record.amount, record.basis === "refund")}</strong>
                <span class="record-chevron" aria-hidden="true"><ChevronRight size={16} strokeWidth={2} /></span>
              </button>
            {/each}
          </section>
        {:else}
          <div class="purchase-empty">
            {#if filterActive}
              <strong>{$t.spendingReview.noMatches}</strong>
              <button type="button" class="button" onclick={clearRecordFilter}>{$t.spendingReview.clearFilter}</button>
            {:else}
              <strong>{$t.purchaseSpending.noPurchases}</strong><span>{$t.purchaseSpending.chooseOtherPeriod}</span>
            {/if}
          </div>
        {/each}
      </div>
      {#if hasMoreRecords}
        <div class="records-more">
          <button type="button" class="button" disabled={recordPageLoading} data-load-more-records onclick={() => void loadMoreRecords()}>
            {recordPageLoading ? $t.common.loading : $t.purchaseSpending.showMore}
          </button>
        </div>
      {/if}
    </section>
    </ProgressiveBlock>

    {#if pairingInvoice?.invoice}
      <section class="pairing-dialog-backdrop" data-pairing-dialog data-pairing-feedback="open-dialog">
        <div class="card pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title" aria-busy={busyAction !== null}>
          <div class="panel-title">
            <div><p class="eyebrow">{$t.purchaseSpending.manualMatch}</p><h2 id="pairing-title">{$t.purchaseSpending.choosePayment}</h2></div>
            <button type="button" class="modal-close" aria-label={$t.common.close} onclick={() => closePairing()}>&times;</button>
          </div>
          <p class="panel-meta">{$t.purchaseSpending.pairingHelp}</p>
          {#if pairingFeedbackText}<p class="panel-meta pairing-feedback" role="status">{pairingFeedbackText}</p>{/if}
          <div class="pairing-invoice-summary">
            <strong>{recordLabel(pairingInvoice)}</strong>
            <span>{dateText(pairingInvoice.occurrence.value)} · <span class="money" data-sensitive>{amountText(pairingInvoice.amount)}</span></span>
          </div>
          <fieldset class="payment-options" data-total-candidate-count={pairingCandidateTotal} data-loaded-candidate-count={pairingCandidates?.length ?? 0}>
            <legend>{$t.purchaseSpending.eligiblePayments}</legend>
            {#if pairingCandidatesLoading}
              <span class="panel-meta pairing-loading" role="status"><span class="pairing-spinner" aria-hidden="true"></span>{$t.purchaseSpending.preparingCandidates}</span>
            {:else}
              {#each visibleEligiblePayments as payment (payment.purchaseId)}
                <label class="payment-option">
                  <input type="radio" name="spending-payment" value={payment.transactionId} checked={selectedPaymentId === payment.transactionId} onchange={() => spendingSession.selectPayment(payment.transactionId)} />
                  <span><strong>{pairingBasisLabel(payment)}</strong><span>{pairingRecordLabel(payment)}</span><small>{dateText(payment.occurrence.value)} · <span class="money" data-sensitive>{amountText(payment.amount)}</span></small></span>
                </label>
              {:else}
                <span class="panel-meta">{$t.purchaseSpending.noEligiblePayments}</span>
              {/each}
            {/if}
            {#if pairingCandidateTotal > paymentVisibleCount}
              <button type="button" class="button secondary show-more-payments" disabled={pairingCandidatesLoading} data-show-more-payments onclick={() => void showMorePayments()}>{$t.purchaseSpending.showMore}</button>
            {/if}
          </fieldset>
          {#if selectedPayment}
            <div class="pairing-effect" data-direct-pair-effect>
              <strong>{$t.purchaseSpending.recognitionAfterMatch}</strong>
              <span>{$t.purchaseSpending.amountCurrencyFromBank}: <span class="money" data-sensitive>{amountText(selectedPayment.amount)}</span></span>
              <span>{$t.purchaseSpending.dateFromInvoice}: {dateText(pairingInvoice.occurrence.value)}</span>
              {#if pairingInvoice.amount?.currency !== selectedPayment.amount?.currency || exactText(pairingInvoice.amount) !== exactText(selectedPayment.amount)}
                <span>{$t.purchaseSpending.sourceDifferenceNotInferred}</span>
              {/if}
            </div>
          {/if}
          {#if busyAction !== null}
            <span class="panel-meta pairing-loading" role="status" data-pairing-feedback="confirm-busy"><span class="pairing-spinner" aria-hidden="true"></span>{$t.purchaseSpending.savingPair}</span>
          {/if}
          <button type="button" class="button primary" disabled={!selectedPayment || pairingCandidatesLoading || busyAction !== null || isUpdating} data-confirm-direct-pair onclick={() => void confirmDirectPair()}>{$t.purchaseSpending.confirmMatch}</button>
        </div>
      </section>
    {/if}

    {#if detailShown && !mergeTab}
      <SpendingPurchaseModal
        record={detailShown}
        pendingItem={detailPendingItem}
        pendingTotal={pendingOverviewCount}
        position={{ index: detailIndex, total: liveRecords.length }}
        {review}
        busy={busyAction !== null || isUpdating}
        onStep={stepPurchase}
        onDecide={(pair, action) => void decidePair(pair, action)}
        onRevoke={(record) => void revokeLink(record)}
        onOpenPairing={openPairing}
        onOpenMerge={openMerge}
        onClose={() => detailRecord = null}
      />
    {/if}

    {#if mergeTab}
      <SpendingMergeModal
        {review}
        initialTab={mergeTab}
        busy={busyAction !== null || isUpdating}
        onDecide={(pair, action) => void decidePair(pair, action)}
        onRevoke={(record) => void revokeLink(record)}
        onClose={() => mergeTab = null}
      />
    {/if}

    {#if canonical.availability === "unavailable"}
      <p class="panel-meta purchase-canonical-note">{$t.purchaseSpending.missingCanonical}</p>
    {/if}
  </div>
</DashboardShell>

<style>
  .purchase-spending { display: grid; gap: var(--space-6); }
  .purchase-spending :global(button) { transition: background 160ms ease, border-color 160ms ease, color 160ms ease; }
  .purchase-action-error { padding: var(--space-4) var(--space-5); border-color: color-mix(in oklch, var(--danger) 35%, var(--border)); background: color-mix(in oklch, var(--danger) 8%, white); color: var(--danger); }
  .muted { color: var(--muted); }
  .accent { color: var(--accent); }
  h2 { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; }

  .merge-trigger { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--fg); font-size: 13px; font-weight: 680; white-space: nowrap; cursor: pointer; }
  .merge-trigger:hover { background: var(--surface-soft); }
  .merge-count { min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: white; font-size: 11px; font-weight: 750; text-align: center; }

  .icon-button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--fg); cursor: pointer; }
  .icon-button:hover:not(:disabled) { background: var(--surface-soft); }
  .icon-button:disabled { opacity: 0.48; cursor: not-allowed; }
  .icon-button:focus-visible, .text-link:focus-visible, .purchase-record:focus-visible, .merge-trigger:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
  .text-link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-weight: 650; cursor: pointer; }
  .text-link:hover { text-decoration: underline; text-underline-offset: 3px; }

  .month-overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: var(--space-8); padding: var(--space-6); }
  .month-summary { display: grid; align-content: start; gap: var(--space-4); min-width: 0; }
  .month-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); }
  .month-nav { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .month-nav h2 { font-size: 20px; white-space: nowrap; }
  .month-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }
  .data-through { padding: 6px 10px; border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 12px; font-weight: 560; white-space: nowrap; }
  .month-figure { display: grid; gap: 6px; min-width: 0; }
  .figure-label, .month-facts dt { color: var(--muted); font-size: 11px; font-weight: 720; letter-spacing: 0.06em; }
  .month-figure > .money { font-size: clamp(32px, 3.4vw, 44px); font-weight: 750; line-height: 1.1; letter-spacing: -0.02em; overflow-wrap: anywhere; }
  .month-standing { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 0; font-size: 14px; line-height: 1.5; }
  .month-standing.muted { font-size: 13px; }
  .standing-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--muted); font-size: 12px; font-weight: 720; }
  .month-standing[data-standing="above"] .standing-chip { background: color-mix(in oklch, var(--warn) 10%, white); color: color-mix(in oklch, var(--warn) 82%, var(--fg)); }
  .standing-difference { font-weight: 560; }
  .month-usual-range { color: var(--muted); font-size: 13px; }
  .month-usual-range .money, .standing-difference .money { white-space: nowrap; }
  .month-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; border: 1px solid var(--border); border-radius: 12px; }
  .month-facts > div { display: grid; align-content: start; gap: 4px; min-width: 0; padding: var(--space-3) var(--space-4); }
  .month-facts > div + div { border-left: 1px solid var(--border); }
  .month-facts dd { margin: 0; min-width: 0; font-size: 20px; font-weight: 750; line-height: 1.25; overflow-wrap: anywhere; }
  .month-facts .fact-sub { color: var(--muted); font-size: 12px; font-weight: 400; }
  .month-facts .fact-sub .money { white-space: nowrap; }
  .month-facts .fact-empty { color: var(--muted); font-size: 13px; font-weight: 500; }
  .pending-fact .text-link { font-size: 12px; }
  .month-caveat { margin: 0; color: var(--warn); font-size: 13px; }
  .month-empty { margin: 0; padding: var(--space-8) 0; color: var(--muted); text-align: center; }

  .category-breakdown { display: grid; align-content: start; gap: 14px; min-width: 0; padding-left: var(--space-8); border-left: 1px solid var(--border); }
  .category-breakdown header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .category-breakdown header span { color: var(--muted); font-size: 12px; }
  .category-bar { display: flex; gap: 2px; height: 10px; overflow: hidden; border-radius: 999px; background: var(--surface-soft); }
  .category-bar span { flex-basis: 0; min-width: 2px; }
  .category-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .category-list li { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 14px; }
  .category-name { flex: 1; min-width: 0; font-weight: 560; }
  .category-share { color: var(--muted); font-size: 13px; font-weight: 700; }
  .category-list .money { min-width: 104px; font-weight: 750; text-align: right; white-space: nowrap; }
  .category-dot { flex: none; width: 8px; height: 8px; border-radius: 999px; }
  .category-empty { margin: 0; color: var(--muted); font-size: 13px; }

  .charts-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 346px); gap: var(--space-6); align-items: stretch; }
  .pace-card, .trend-card { display: grid; align-content: start; gap: var(--space-3); min-width: 0; padding: var(--space-5); }
  .trend-card { grid-template-rows: auto auto 1fr; }
  .card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-3); }
  .card-head p, .records-title p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
  .pace-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; color: var(--muted); font-size: 12px; font-weight: 560; list-style: none; }
  .pace-legend li { display: inline-flex; align-items: center; gap: 6px; }
  .legend-line { width: 14px; height: 3px; border-radius: 2px; background: var(--accent); }
  .legend-dash { width: 14px; height: 0; border-top: 2px dashed var(--muted); }
  .legend-band { width: 14px; height: 10px; border-radius: 2px; background: color-mix(in oklch, var(--muted) 12%, transparent); }
  .month-chart-pending { min-height: 340px; border-radius: 12px; background: var(--surface-soft); }
  .trend-chart-pending { min-height: 240px; border-radius: 12px; background: var(--surface-soft); }
  .day-detail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; }
  .day-detail > span { color: var(--muted); }
  .day-detail > .money { color: var(--fg); font-weight: 750; }
  .day-detail .button { min-height: 32px; margin-left: auto; }
  .chart-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); }
  .chart-period-picker { display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font-size: 12px; }
  .chart-period-picker select { min-height: 32px; max-width: 210px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--fg); font: inherit; }
  .chart-hint { margin: 0; color: var(--muted); font-size: 12px; }
  .trend-stats { display: grid; align-content: end; gap: 10px; margin: 0; padding-top: var(--space-3); border-top: 1px solid var(--border); }
  .trend-stats > div { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .trend-stats dt { display: grid; gap: 1px; color: var(--muted); font-size: 12px; font-weight: 560; }
  .trend-stats dt small { font-size: 11px; font-weight: 400; }
  .trend-stats dd { margin: 0; font-size: 14px; font-weight: 750; text-align: right; white-space: nowrap; }
  .trend-stats dd .muted { font-size: 12px; font-weight: 400; white-space: normal; }

  .purchase-records-card { min-width: 0; overflow: hidden; }
  .records-head { display: grid; gap: 14px; padding: var(--space-5) var(--space-5) var(--space-4); }
  .records-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .records-title > div { flex: 1; min-width: 0; }
  .record-search { display: flex; align-items: center; gap: var(--space-2); width: min(240px, 100%); height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--muted); }
  .record-search:focus-within { border-color: var(--fg); box-shadow: 0 0 0 3px var(--surface-soft); }
  .record-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: none; background: transparent; color: var(--fg); font: inherit; font-size: 13px; }
  .record-search input::placeholder { color: var(--muted); }
  .category-filter { display: flex; flex-wrap: wrap; justify-self: start; gap: 2px; padding: 4px; border-radius: 12px; background: var(--surface-soft); }
  .category-filter .filter-btn { gap: 6px; font-weight: 560; }
  .category-filter .filter-btn[aria-pressed="true"] { border-color: var(--border); background: var(--surface); color: var(--fg); font-weight: 700; box-shadow: 0 1px 2px rgb(15 23 42 / 0.08); }
  .category-filter .category-dot { width: 7px; height: 7px; }
  .chip-count { color: var(--muted); font-size: 12px; font-weight: 700; }
  .purchase-day-group { border-top: 1px solid var(--border); }
  .purchase-day-heading { display: flex; align-items: center; gap: 10px; padding: 9px var(--space-5); border-bottom: 1px solid var(--border); background: var(--surface-soft); }
  .purchase-day-heading strong { font-size: 13px; }
  .purchase-day-heading > span { color: var(--muted); font-size: 12px; }
  .day-totals { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); margin-left: auto; padding-right: 28px; }
  .day-totals .money { font-size: 13px; font-weight: 750; }
  .purchase-record { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 62px; padding: 12px var(--space-5); border: 0; border-bottom: 1px solid color-mix(in oklch, var(--border) 70%, transparent); background: var(--surface); color: var(--fg); font: inherit; text-align: left; }
  .purchase-day-group .purchase-record:last-child { border-bottom: 0; }
  .purchase-record { cursor: pointer; }
  .purchase-record:hover { background: color-mix(in oklch, var(--accent) 4%, white); }
  .record-texts { display: grid; flex: 1; gap: 2px; min-width: 0; }
  .record-texts strong { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .record-texts > span { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .fallback-date { color: var(--warn); font-weight: 700; }
  .status-tag { display: inline-flex; flex: none; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 720; white-space: nowrap; }
  .status-tag.pending { background: var(--accent-soft); color: var(--accent); }
  .record-amount { flex: none; min-width: 110px; font-size: 14px; font-weight: 750; text-align: right; white-space: nowrap; }
  .record-chevron { display: grid; flex: none; place-items: center; width: 16px; color: var(--muted); }
  .records-more { padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
  .records-more .button { width: 100%; }
  .purchase-empty { display: grid; justify-items: center; gap: var(--space-2); padding: var(--space-8) var(--space-5); border-top: 1px solid var(--border); color: var(--muted); text-align: center; }
  .purchase-empty strong { color: var(--fg); }
  .purchase-canonical-note { margin: 0; color: var(--muted); font-size: 12px; }

  .pairing-dialog-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: var(--space-5); background: rgba(14, 18, 28, 0.44); -webkit-backdrop-filter: blur(10px) saturate(0.84); backdrop-filter: blur(10px) saturate(0.84); }
  .pairing-dialog { width: min(680px, 100%); max-height: 85vh; overflow: auto; padding: var(--space-5); }
  .pairing-invoice-summary, .pairing-effect { display: grid; gap: 4px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
  .pairing-invoice-summary span, .pairing-effect span { color: var(--muted); font-size: 12px; }
  .payment-options { display: grid; gap: var(--space-2); margin: var(--space-4) 0; padding: 0; border: 0; }
  .payment-options legend { margin-bottom: var(--space-2); font-weight: 700; }
  .payment-option { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
  .payment-option:hover { border-color: color-mix(in oklch, var(--accent) 35%, var(--border)); background: var(--accent-soft); }
  .payment-option > span { display: grid; gap: 3px; }
  .payment-option small { color: var(--muted); }
  .pairing-effect { margin-bottom: var(--space-4); }
  .pairing-loading { display: inline-flex; align-items: center; gap: 7px; }
  .pairing-spinner { width: 12px; height: 12px; border: 2px solid color-mix(in oklch, var(--accent) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: pairing-spin 700ms linear infinite; }
  @keyframes pairing-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .pairing-spinner { animation: none; }
  }

  @media (max-width: 1100px) {
    .month-overview { grid-template-columns: 1fr; gap: var(--space-6); }
    .category-breakdown { padding: var(--space-6) 0 0; border-top: 1px solid var(--border); border-left: 0; }
    .charts-row { grid-template-columns: 1fr; }
  }
  @media (max-width: 680px) {
    .month-overview { padding: var(--space-5); }
    .month-facts { grid-template-columns: 1fr; }
    .month-facts > div + div { border-top: 1px solid var(--border); border-left: 0; }
    .record-search { width: 100%; }
    .day-detail .button { margin-left: 0; }
    .purchase-record { flex-wrap: wrap; }
    .record-amount { min-width: 0; }
    .status-tag { order: 4; }
    .day-totals { padding-right: 0; }
  }
</style>
