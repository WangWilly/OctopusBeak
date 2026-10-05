<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
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
    readSpendingMonth,
    readSpendingTrend,
    type CurrencyCode,
    type MonthReading,
  } from "../spending-insights.ts";
  import MonthPaceChart from "./MonthPaceChart.svelte";
  import MonthTrendChart from "./MonthTrendChart.svelte";
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

  export let retryBlock: (key: string) => void = () => {};

  function blockState(key: "summary" | "chart" | "list" | "details"): BlockState<DashboardBlockPayload> {
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
    key: "summary" | "chart" | "list" | "details",
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
  let candidateVisibleCount = 10;
  let monthCandidateCount: number | null = null;
  let monthCandidateLoading = false;
  let recordPageLoading = false;
  let hasMoreRecords = false;
  let pairingCandidates: readonly SpendingPairingCandidateView[] | null = null;
  let validatedSelectedCandidate: SpendingPairingCandidateView | null = null;
  let pairingCandidateTotal = 0;
  let pairingCandidatesLoading = false;
  let pageError = "";
  const reportDerivedCache = new WeakMap<object, {
    months: readonly string[];
    availableCurrencies: readonly string[];
    pendingCandidates: PurchaseReport["candidates"];
    candidateRecordsByKey: Map<string, PurchaseRecord>;
  }>();
  const reportRecordsCache = new WeakMap<object, Map<string, PurchaseRecord[]>>();
  const reportVisibleRecordsCache = new WeakMap<object, Map<string, PurchaseRecord[]>>();

  $: report = $spendingState.report;
  $: isUpdating = $spendingState.isUpdating;
  $: canonical = $spendingState.canonical;
  $: selectedMonth = $spendingState.selectedMonth;
  $: selectedDay = $spendingState.selectedDay;
  $: busyAction = $spendingState.busyAction;
  $: actionError = $spendingState.actionError;
  $: pageError = $spendingState.pageError;
  $: pairingFeedback = $spendingState.pairingFeedback;
  $: pairingInvoice = $spendingState.pairingInvoice;
  $: selectedPaymentId = $spendingState.selectedPaymentId;
  $: paymentVisibleCount = $spendingState.paymentVisibleCount;
  $: candidateVisibleCount = $spendingState.candidateVisibleCount;
  $: monthCandidateCount = $spendingState.monthCandidateCount;
  $: monthCandidateLoading = $spendingState.monthCandidateLoading;
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
      spendingSession.dispose();
    };
  });

  function recordsForMonth(sourceReport: PurchaseReport, month: string | null) {
    const key = month ?? "*";
    const cachedByMonth = reportRecordsCache.get(sourceReport);
    const cached = cachedByMonth?.get(key);
    if (cached) return cached;
    const records = sourceReport.records.filter((record) =>
      month === null || record.occurrence.value.startsWith(`${month}-`));
    const nextByMonth = cachedByMonth ?? new Map<string, PurchaseRecord[]>();
    nextByMonth.set(key, records);
    reportRecordsCache.set(sourceReport, nextByMonth);
    return records;
  }

  function visibleRecordsFor(sourceReport: PurchaseReport, month: string | null, day: string | null) {
    const key = `${month ?? "*"}\u0000${day ?? "*"}`;
    const cachedByFilter = reportVisibleRecordsCache.get(sourceReport);
    const cached = cachedByFilter?.get(key);
    if (cached) return cached;
    const records = recordsForMonth(sourceReport, month)
      .filter((record) => day === null || record.occurrence.value.startsWith(day))
      .slice()
      .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
    const nextByFilter = cachedByFilter ?? new Map<string, PurchaseRecord[]>();
    nextByFilter.set(key, records);
    reportVisibleRecordsCache.set(sourceReport, nextByFilter);
    return records;
  }

  function reportDerivedFor(sourceReport: PurchaseReport) {
    const cached = reportDerivedCache.get(sourceReport);
    if (cached) return cached;
    const derived = {
      months: monthsForReport(sourceReport),
      availableCurrencies: currenciesForReport(sourceReport),
      pendingCandidates: sourceReport.candidates.filter((candidate) => candidate.status === "candidate"),
      candidateRecordsByKey: candidateRecordsByKeyFor(sourceReport),
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
  $: visibleRecords = visibleRecordsFor(report, activeMonth, selectedDay);
  $: availableCurrencies = reportDerived.availableCurrencies;
  $: if (!selectedCurrency || !availableCurrencies.includes(selectedCurrency)) selectedCurrency = availableCurrencies[0] ?? "TWD";
  $: pendingCandidates = reportDerived.pendingCandidates;
  $: monthCandidates = pendingCandidates.filter((candidate) => {
    const invoice = candidateRecordsByKey.get(`${candidate.candidateId}:invoice`);
    const transaction = candidateRecordsByKey.get(`${candidate.candidateId}:transaction`);
    return activeMonth === null || invoice?.occurrence.value.startsWith(`${activeMonth}-`) || transaction?.occurrence.value.startsWith(`${activeMonth}-`);
  });
  $: visibleCandidates = monthCandidates;
  $: visibleCandidateRows = visibleCandidates.slice(0, candidateVisibleCount);
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
    : visibleRecords.length;
  $: reading = report.summary ? readSpendingMonth(report.summary, { month: activeMonth, today }) : null;
  $: current = reading?.byCurrency.get(selectedCurrency as CurrencyCode) ?? null;
  $: monthFigure = current?.total ?? visibleTotals.find((amount) => amount.currency === selectedCurrency) ?? null;
  $: trend = reading && report.summary
    ? readSpendingTrend(report.summary, { currency: selectedCurrency, selectedMonth: reading.month, today })
    : [];
  $: selectedDayReading = current?.days.find((day) => day.date === selectedDay) ?? null;
  $: activeMonthIndex = activeMonth ? months.indexOf(activeMonth) : -1;
  $: previousMonthKey = activeMonthIndex > 0 ? months[activeMonthIndex - 1] : null;
  $: nextMonthKey = activeMonthIndex >= 0 ? months[activeMonthIndex + 1] ?? null : null;
  $: pendingAffectsTotal = reading
    ? reading.caveat.kind === "may-include-duplicates"
    : report.totalStatus === "includes-pending-confirmation";
  $: candidateRecordsByKey = reportDerived.candidateRecordsByKey;

  function amountText(amount: ExactMoney | null, signed = false) {
    if (!amount) return $t.purchaseSpending.amountUnavailable;
    return moneyText(amount, $locale, signed);
  }

  function shortMonthText(value: string) {
    return new Intl.DateTimeFormat($locale, { month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1)));
  }

  function monthDayText(value: string) {
    return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
  }

  function dayTotalsFor(sourceReading: MonthReading | null, date: string, loaded: readonly ExactMoney[]) {
    if (!sourceReading || !date.startsWith(`${sourceReading.month}-`)) return loaded;
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

  function showPendingMatches() {
    document.querySelector("[data-candidates]")?.scrollIntoView({ block: "start" });
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

  function dateText(value: string) {
    const date = value.slice(0, 10);
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? date
      : new Intl.DateTimeFormat($locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
  }

  function monthText(value: string) {
    const [year, month] = value.split("-").map(Number);
    if (!year || !month) return value;
    return new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  }

  function linkedDatesText(record: PurchaseRecord, transaction: NonNullable<PurchaseRecord["transaction"]>) {
    const invoiceDate = record.occurrence.value.slice(0, 10);
    const postingDate = (transaction.postingDate ?? transaction.effectiveOn).slice(0, 10);
    const parts = [`${$t.purchaseSpending.invoicePurchaseDate}: ${dateText(invoiceDate)}`];
    if (!transaction.consumeDate) parts.push(`${$t.purchaseSpending.consumeDate}: ${$t.purchaseSpending.notProvided}`);
    else if (transaction.consumeDate.slice(0, 10) !== invoiceDate) parts.push(`${$t.purchaseSpending.consumeDate}: ${dateText(transaction.consumeDate)}`);
    if (postingDate !== invoiceDate) parts.push(`${$t.purchaseSpending.postingDate}: ${dateText(postingDate)}`);
    return parts.join(" · ");
  }

  function recordLabel(record: PurchaseRecord) {
    return record.description ?? record.invoice?.revision.seller.name ?? record.transaction?.description ?? $t.purchaseSpending.merchantUnavailable;
  }

  function basisLabel(record: PurchaseRecord) {
    if (record.basis === "linked") return $t.purchaseSpending.linkedPurchase;
    if (record.basis === "invoice") return $t.purchaseSpending.invoicePurchase;
    if (record.basis === "refund") return $t.purchaseSpending.refund;
    const isCreditCard = record.transaction?.stream === "credit-card";
    return isCreditCard ? $t.purchaseSpending.creditCardPurchase : $t.purchaseSpending.bankTransaction;
  }

  function pairingRecordLabel(candidate: SpendingPairingCandidateView) {
    return candidate.description ?? $t.purchaseSpending.merchantUnavailable;
  }

  function pairingBasisLabel(candidate: SpendingPairingCandidateView) {
    return candidate.stream === "credit-card" ? $t.purchaseSpending.creditCardPurchase : $t.purchaseSpending.bankTransaction;
  }

  function occurrenceBasisLabel(record: PurchaseRecord) {
    return record.occurrence.basis === "posting-date-fallback" ? $t.purchaseSpending.postingDateFallback : null;
  }

  function transactionDateBasisLabel(transaction: NonNullable<PurchaseRecord["transaction"]>) {
    return transaction.effectiveDateBasis === "posting-date-fallback" ? $t.purchaseSpending.consumeDateFallback : null;
  }

  function candidateRecord(candidateId: string, kind: "invoice" | "transaction") {
    return candidateRecordsByKey.get(`${candidateId}:${kind}`) ?? null;
  }

  function candidateRecordsByKeyFor(sourceReport: PurchaseReport) {
    const index = new Map<string, PurchaseRecord>();
    for (const record of sourceReport.records) {
      for (const candidateId of record.candidateIds) {
        if (record.invoice) index.set(`${candidateId}:invoice`, record);
        if (record.transaction) index.set(`${candidateId}:transaction`, record);
      }
    }
    return index;
  }

  function monthsForReport(sourceReport: PurchaseReport) {
    return sourceReport.summary?.monthTotals.map((month) => month.month)
      ?? [...new Set(sourceReport.records.map((record) => record.occurrence.value.slice(0, 7)))].sort();
  }

  function activeMonthForReport(sourceReport: PurchaseReport, preferred: string | null) {
    const months = monthsForReport(sourceReport);
    return preferred && months.includes(preferred) ? preferred : months.at(-1) ?? null;
  }

  function purchaseListView(
    sourceReport: PurchaseReport,
    preferredMonth: string | null,
    visibleCount: number,
  ) {
    const active = activeMonthForReport(sourceReport, preferredMonth);
    const recordsByKey = candidateRecordsByKeyFor(sourceReport);
    const pending = sourceReport.candidates.filter((candidate) => candidate.status === "candidate");
    const month = pending.filter((candidate) => {
      const invoice = recordsByKey.get(`${candidate.candidateId}:invoice`);
      const transaction = recordsByKey.get(`${candidate.candidateId}:transaction`);
      return active === null
        || invoice?.occurrence.value.startsWith(`${active}-`)
        || transaction?.occurrence.value.startsWith(`${active}-`);
    });
    const visible = month;
    return {
      pending,
      month,
      visible,
      rows: visible.slice(0, visibleCount),
      recordsByKey,
    };
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
    spendingSession.chooseMonth(month);
  }

  function confirmCandidate(candidateId: string) {
    return spendingSession.confirmCandidate(candidateId);
  }

  function denyCandidate(candidateId: string) {
    return spendingSession.denyCandidate(candidateId);
  }

  function openPairing(record: PurchaseRecord) {
    spendingSession.openPairing(record);
  }

  function closePairing() {
    spendingSession.closePairing();
  }

  function showMoreCandidates() {
    return spendingSession.showMoreCandidates();
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

  function revokeLink(record: PurchaseRecord) {
    return spendingSession.revokeLink(record);
  }

  function itemCategory(item: PurchaseRecord["items"][number]) {
    const category = item.sourceFacts.category;
    return typeof category === "string" && category.trim()
      ? category
      : $t.purchaseSpending.unclassified;
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
  <div class="content spending-dashboard purchase-spending" data-spending-canonical data-purchase-report>
    <details class="purchase-basis-banner" data-policy-id="gross-posted-outflow">
      <summary><strong>{$t.purchaseSpending.basisTitle}</strong><span>{$t.spendingInsight.basisSummary}</span></summary>
      <p>{$t.purchaseSpending.basisDescription}</p>
    </details>

    {#if recordPageLoading || isUpdating}
      <p role="status" data-spending-updating>{$t.common.loading}</p>
    {/if}
    {#if actionErrorText || pageError}
      <section class="card purchase-action-error" role="alert">{actionErrorText || pageError}</section>
    {/if}

    <div class="purchase-analysis-grid">
      <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")} let:data>
      {@const summaryBlock = spendingBlockData("summary", data)}
      <section class="card spending-month-panel" data-month-panel aria-labelledby="spending-month-title">
        <header class="month-panel-head">
          <div class="month-nav">
            <button type="button" class="button month-step" aria-label={$t.spendingInsight.previousMonth} disabled={!previousMonthKey} onclick={() => previousMonthKey && chooseMonth(previousMonthKey)}>
              <ChevronLeft size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
            <h2 id="spending-month-title">{activeMonth ? monthText(activeMonth) : $t.purchaseSpending.allMonths}</h2>
            <button type="button" class="button month-step" aria-label={$t.spendingInsight.nextMonth} disabled={!nextMonthKey} onclick={() => nextMonthKey && chooseMonth(nextMonthKey)}>
              <ChevronRight size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          <div class="month-controls">
            {#if months.length > 0}
              <label class="month-picker">
                <span class="visually-hidden">{$t.purchaseSpending.month}</span>
                <select value={activeMonth ?? ""} onchange={(event) => chooseMonth(event.currentTarget.value)}>
                  {#each [...months].reverse() as month}
                    <option value={month}>{monthText(month)}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if availableCurrencies.length > 1}
              <div class="filters currency-switch" role="group" aria-label={$t.purchaseSpending.chartCurrency}>
                {#each availableCurrencies as currency}
                  <button type="button" class="filter-btn" aria-pressed={currency === selectedCurrency} onclick={() => selectedCurrency = currency}>{currency}</button>
                {/each}
              </div>
            {/if}
          </div>
        </header>

        <div class="month-reading">
          <div class="month-figure">
            <strong class="money" data-sensitive>{amountText(monthFigure)}</strong>
            {#if reading && current}
              {#if current.standing.kind === "no-usual"}
                <p class="month-standing">{$t.spendingInsight.usualNotYet(3 - (current.usual.kind === "unavailable" ? current.usual.fullMonthsAvailable : 0))}</p>
              {:else}
                <p class="month-standing" data-standing={current.standing.kind}>
                  <strong>{reading.span.kind === "in-progress" ? $t.spendingInsight.standingToDate[current.standing.kind] : $t.spendingInsight.standing[current.standing.kind]}</strong>
                  <span class="standing-difference">{$t.spendingInsight.differencePrefix} <span class="money" data-sensitive>{amountText(current.standing.differenceFromMean, true)}</span> {$t.spendingInsight.differenceSuffix}</span>
                </p>
              {/if}
              {#if current.usual.kind === "available"}
                <p class="month-usual-range">
                  {reading.span.kind === "in-progress" ? $t.spendingInsight.usualRangeToDate(reading.span.throughDay) : $t.spendingInsight.usualRange}
                  <span class="money" data-sensitive>{amountText(current.usual.low)}</span>–<span class="money" data-sensitive>{amountText(current.usual.high)}</span>
                </p>
              {/if}
            {/if}
          </div>
          {#if reading && current}
            <dl class="month-facts">
              <div>
                <dt>{$t.spendingInsight.dailyMean}</dt>
                <dd><span class="money" data-sensitive>{amountText(current.dailyMean)}</span></dd>
                {#if current.usual.kind === "available"}<dd class="fact-sub">{$t.spendingInsight.usualDailyMean} <span class="money" data-sensitive>{amountText(current.usual.dailyMean)}</span></dd>{/if}
              </div>
              <div><dt>{$t.purchaseSpending.activeDays}</dt><dd class="num">{current.activeDays}</dd></div>
              <div><dt>{$t.purchaseSpending.purchaseCount}</dt><dd class="num">{reading.recordCount}</dd></div>
              <div><dt>{$t.purchaseSpending.pendingThisMonth}</dt><dd class="num">{reading.caveat.kind === "may-include-duplicates" ? reading.caveat.pendingPairs : reading.caveat.kind === "confirmed" ? 0 : "—"}</dd></div>
            </dl>
          {/if}
        </div>

        {#if reading?.caveat.kind === "checking"}
          <p class="month-caveat" role="status" data-total-status="month-pending-unloaded">{$t.spendingInsight.checkingDuplicates}</p>
        {:else if reading ? reading.caveat.kind === "may-include-duplicates" : (summaryBlock?.purchaseReport.totalStatus ?? report.totalStatus) === "includes-pending-confirmation"}
          <p class="month-caveat caution" data-pending-total data-total-status="includes-pending-confirmation">
            {$t.purchaseSpending.pendingTotalNote}
            {#if report.summary}<button type="button" class="caveat-link" onclick={showPendingMatches}>{$t.spendingInsight.reviewPending}</button>{/if}
          </p>
        {/if}

        {#if reading && current}
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
              {#if current.usual.kind === "available"}<span>{$t.spendingInsight.usualDailyMean} <span class="money" data-sensitive>{amountText(current.usual.dailyMean)}</span></span>{/if}
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
            <p class="chart-hint">{$t.purchaseSpending.dayHint}</p>
          </div>
          <div class="month-footnotes">
            {#if current.usual.kind === "available"}
              <p>{reading.span.kind === "in-progress"
                ? $t.spendingInsight.usualBasisToDate(shortMonthText(current.usual.months[0]), shortMonthText(current.usual.months[2]), reading.span.throughDay)
                : $t.spendingInsight.usualBasis(shortMonthText(current.usual.months[0]), shortMonthText(current.usual.months[2]))}</p>
            {/if}
            {#if reading.span.kind === "in-progress"}
              <p>{reading.latestRecordDate ? `${$t.spendingInsight.dataThrough(monthDayText(reading.latestRecordDate))} · ` : ""}{$t.spendingInsight.throughDay(reading.span.throughDay, reading.span.daysInMonth)}</p>
            {/if}
          </div>
        {:else if reading}
          <p class="month-empty">{$t.spendingInsight.noCurrencyThisMonth(selectedCurrency)}</p>
        {/if}
      </section>
      </ProgressiveBlock>

      {#if reading}
        <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")}>
          <section class="card spending-trend-card" aria-labelledby="spending-trend-title">
            <h2 id="spending-trend-title">{$t.spendingInsight.trendTitle}</h2>
            <p class="trend-currency">{selectedCurrency}</p>
            {#if chartReady}
              <MonthTrendChart months={trend} selectedMonth={reading.month} onSelectMonth={chooseMonth} />
            {:else}
              <div class="trend-chart-pending" aria-hidden="true"></div>
            {/if}
          </section>
        </ProgressiveBlock>
      {/if}
    </div>

    <ProgressiveBlock label="list" state={blockState("list")} retry={() => retryBlock("list")} let:data>
    {@const listReport = report.summary ? report : resolveSpendingPurchaseReport(report, spendingBlockData("list", data))}
    {@const listView = purchaseListView(listReport, activeMonth, candidateVisibleCount)}
    {#if listView.pending.length > 0 || report.summary && (monthCandidateCount === null || monthCandidateLoading)}
      <section class="card purchase-candidates-card" data-candidates>
        <div class="section-heading">
          <div><h2>{$t.purchaseSpending.pendingMatches}</h2><p>{$t.purchaseSpending.pendingMatchesDescription}</p></div>
          <div class="candidate-scope">
            {#if report.summary && monthCandidateCount === null}
              <span role="status">{$t.purchaseSpending.preparingCandidates}</span>
            {:else}
              <span>{$t.purchaseSpending.itemsCount(report.summary ? monthCandidateCount ?? 0 : listView.visible.length)}</span>
            {/if}
          </div>
        </div>
        <div class="candidate-list">
          {#if listView.visible.length === 0}
            {#if (report.summary && monthCandidateCount === null) || monthCandidateLoading}
              <p class="candidate-empty pairing-loading" role="status"><span class="pairing-spinner" aria-hidden="true"></span>{$t.purchaseSpending.preparingCandidates}</p>
            {:else}
              <p class="candidate-empty">{$t.purchaseSpending.noPendingMatches}</p>
            {/if}
          {/if}
          {#each listView.rows as candidate (candidate.candidateId)}
            {@const invoiceRecord = listView.recordsByKey.get(`${candidate.candidateId}:invoice`) ?? null}
            {@const transactionRecord = listView.recordsByKey.get(`${candidate.candidateId}:transaction`) ?? null}
            <article class="candidate-row" data-candidate-id={candidate.candidateId}>
              <div class="candidate-side">
                <strong>{$t.purchaseSpending.invoiceSource}</strong>
                <span>{invoiceRecord?.invoice?.revision.seller.name ?? $t.purchaseSpending.merchantUnavailable}</span>
                <span>{invoiceRecord ? dateText(invoiceRecord.occurrence.value) : "--"} · <span class="money" data-sensitive>{invoiceRecord ? amountText(invoiceRecord.amount) : "--"}</span></span>
              </div>
              <div class="candidate-compare"><span class="possible-duplicate">{$t.purchaseSpending.possibleMatch}</span><span>{$t.purchaseSpending.review}</span></div>
              <div class="candidate-side">
                <strong>{transactionRecord ? basisLabel(transactionRecord) : $t.purchaseSpending.bankSource}</strong>
                <span>{transactionRecord?.transaction?.description ?? $t.purchaseSpending.descriptionUnavailable}</span>
                <span>{transactionRecord ? dateText(transactionRecord.occurrence.value) : "--"} · <span class="money" data-sensitive>{transactionRecord ? amountText(transactionRecord.amount) : "--"}</span></span>
              </div>
              <div class="candidate-actions">
                <button type="button" class="button primary" disabled={busyAction !== null || isUpdating} data-confirm-candidate onclick={() => void confirmCandidate(candidate.candidateId)}>{$t.purchaseSpending.confirmMatch}</button>
                <button type="button" class="button secondary" disabled={busyAction !== null || isUpdating} data-deny-candidate onclick={() => void denyCandidate(candidate.candidateId)}>{$t.purchaseSpending.denyCandidate}</button>
              </div>
            </article>
          {/each}
          {#if report.summary ? monthCandidateCount !== null && monthCandidateCount > candidateVisibleCount : listView.visible.length > candidateVisibleCount}
            <button type="button" class="button secondary show-more-candidates" data-show-more-candidates onclick={() => void showMoreCandidates()}>{$t.purchaseSpending.showMore}</button>
          {/if}
        </div>
      </section>
    {/if}
    </ProgressiveBlock>

    <ProgressiveBlock label="details" state={blockState("details")} retry={() => retryBlock("details")} let:data>
    {@const detailsReport = report.summary ? report : resolveSpendingPurchaseReport(report, spendingBlockData("details", data))}
    {@const detailsActiveMonth = activeMonthForReport(detailsReport, activeMonth)}
    {@const detailsMonthRecords = detailsReport.records.filter((record) => detailsActiveMonth === null || record.occurrence.value.startsWith(`${detailsActiveMonth}-`))}
    {@const detailsVisibleRecords = detailsMonthRecords
      .filter((record) => selectedDay === null || record.occurrence.value.startsWith(selectedDay))
      .slice()
      .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId))}
    {@const detailsRecordGroups = groupRecordsByDate(detailsVisibleRecords)}
    <section class="card purchase-records-card">
      <div class="section-heading records-heading">
        <div><h2>{$t.purchaseSpending.purchases}</h2><p>{selectedDay ? dateText(selectedDay) : detailsActiveMonth ? monthText(detailsActiveMonth) : $t.purchaseSpending.allRecords} · {$t.purchaseSpending.recordsCount(periodRecordCount)}</p></div>
        {#if selectedDay}<button type="button" class="button secondary" onclick={() => spendingSession.chooseDay(null)}>{$t.purchaseSpending.showFullMonth}</button>{/if}
      </div>
      <div class="purchase-record-list">
        {#each detailsRecordGroups as group (group.date)}
          <section class="purchase-day-group" data-purchase-day={group.date}>
            <header class="purchase-day-heading">
              <div><strong>{dateText(group.date)}</strong><span>{$t.purchaseSpending.dayPurchasesCount(group.records.length)}</span></div>
              <div class="day-totals">{#each dayTotalsFor(reading, group.date, group.totals) as total (total.currency)}<span class="money" data-sensitive>{amountText(total)}</span>{/each}</div>
            </header>
            {#each group.records as record (record.purchaseId)}
          <article class:possible={record.possibleDuplicate} class="purchase-record" data-purchase-record data-basis={record.basis} data-transaction-id={record.transaction?.transactionId ?? ""} data-possible-duplicate={record.possibleDuplicate}>
            <div class="purchase-record-main">
              <div class="purchase-record-heading"><strong>{recordLabel(record)}</strong><span class="purchase-basis">{basisLabel(record)}</span>{#if record.possibleDuplicate}<span class="possible-duplicate">{$t.purchaseSpending.possibleDuplicate}</span>{/if}</div>
              {#if occurrenceBasisLabel(record)}<span class="fallback-date" data-date-basis="posting-date-fallback">{occurrenceBasisLabel(record)}</span>{/if}
              {#if record.basis === "linked" && record.transaction}
                <span>{$t.purchaseSpending.paymentAmount}: <span class="money" data-sensitive>{amountText(record.transaction.amount)}</span></span>
                <span>{linkedDatesText(record, record.transaction)}</span>
                {#if transactionDateBasisLabel(record.transaction)}<span class="fallback-date" data-transaction-date-basis="posting-date-fallback">{transactionDateBasisLabel(record.transaction)}</span>{/if}
                {#if record.difference}<span data-link-difference>{$t.purchaseSpending.invoiceAmount}: <span class="money" data-sensitive>{amountText(record.difference.invoiceAmount)}</span> · {$t.purchaseSpending.bankAmount}: <span class="money" data-sensitive>{amountText(record.difference.bankAmount)}</span> · {$t.purchaseSpending.difference}: {#if record.difference.exactAmountEqual}<span class="money" data-sensitive>0</span>{:else}{$t.purchaseSpending.amountDifferenceNotInferred}{/if}</span>{/if}
              {/if}
              {#if record.items.length > 0}
                <details class="item-list" data-item-details>
                  <summary>{$t.purchaseSpending.invoiceItemsCount(record.items.length)}</summary>
                  {#each record.items as item (item.itemId)}
                    <span>{item.name ?? $t.purchaseSpending.itemNameUnavailable} · {$t.purchaseSpending.quantity}: <span class="num">{exactText(item.quantity)}</span> · {$t.purchaseSpending.category}: {itemCategory(item)} · {$t.purchaseSpending.itemAmount}: <span class="money" data-sensitive>{amountText(item.amount)}</span></span>
                  {/each}
                </details>
              {/if}
              {#if record.basis === "invoice" && record.invoice}
                <button type="button" class="button secondary pair-button" disabled={busyAction !== null || isUpdating} data-open-pairing onclick={() => openPairing(record)}>{$t.purchaseSpending.matchPayment}</button>
              {/if}
              {#if record.link}
                <details class="source-details" data-source-details><summary>{$t.purchaseSpending.sourceAndMatchEvidence}</summary><div>{$t.purchaseSpending.matchEvent}: {record.link.eventId} · {$t.purchaseSpending.knowledge}: {record.link.evidenceKnowledgeSequence} · {$t.purchaseSpending.origin}: {record.link.origin}</div><pre>{JSON.stringify(record.link.evidence)}</pre></details>
                <button type="button" class="button revoke-button" disabled={busyAction !== null || isUpdating} data-revoke-link onclick={() => void revokeLink(record)}>{$t.purchaseSpending.revokeMatch}</button>
              {/if}
              {#if record.refund}<span class="refund-note">{$t.purchaseSpending.refundPeriod} · {record.refund.provenanceReference}</span>{/if}
            </div>
            <div class="purchase-record-side"><strong class="money" data-sensitive>{amountText(record.amount, record.basis === "refund")}</strong></div>
          </article>
            {/each}
          </section>
        {:else}<div class="purchase-empty"><strong>{$t.purchaseSpending.noPurchases}</strong><span>{$t.purchaseSpending.chooseOtherPeriod}</span></div>{/each}
      </div>
      {#if hasMoreRecords}
        <button type="button" class="button secondary" disabled={recordPageLoading} data-load-more-records onclick={() => void loadMoreRecords()}>
          {recordPageLoading ? $t.common.loading : $t.purchaseSpending.showMore}
        </button>
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

    {#if canonical.availability === "unavailable"}
      <p class="panel-meta purchase-canonical-note">{$t.purchaseSpending.missingCanonical}</p>
    {/if}
  </div>
</DashboardShell>

<style>
  .purchase-spending { display: grid; gap: var(--space-6); }
  .purchase-spending :global(button) { transition: background 160ms ease, border-color 160ms ease, color 160ms ease; }
  .spending-month-panel, .spending-trend-card, .purchase-candidates-card, .purchase-records-card, .purchase-action-error { min-width: 0; }
  .possible-duplicate, .purchase-action-error { color: var(--danger); }
  .purchase-action-error { padding: var(--space-4) var(--space-5); background: color-mix(in oklch, var(--danger) 8%, white); }

  .purchase-basis-banner { padding: var(--space-2) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); color: var(--muted); font-size: 13px; }
  .purchase-basis-banner summary { display: flex; align-items: baseline; gap: var(--space-3); cursor: pointer; list-style: none; }
  .purchase-basis-banner summary::-webkit-details-marker { display: none; }
  .purchase-basis-banner summary::after { content: ""; flex: 0 0 auto; align-self: center; width: 5px; height: 5px; margin-left: auto; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform 180ms ease; }
  .purchase-basis-banner[open] summary::after { transform: rotate(-135deg); }
  .purchase-basis-banner summary strong { flex: 0 0 auto; color: var(--fg); font-size: 13px; }
  .purchase-basis-banner p { max-width: 75ch; margin: var(--space-2) 0 var(--space-1); }

  .purchase-analysis-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); gap: var(--space-6); align-items: start; }
  .spending-month-panel, .spending-trend-card, .purchase-candidates-card, .purchase-records-card { padding: var(--space-5); }
  .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
  .section-heading h2 { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.25; letter-spacing: -0.015em; }
  .section-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }

  .month-panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3) var(--space-4); }
  .month-nav { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .month-nav h2 { min-width: 0; margin: 0 var(--space-1); font-size: 16px; font-weight: 700; line-height: 1.3; }
  .month-step { width: 40px; padding: 0; }
  .month-step:disabled { opacity: 0.48; cursor: not-allowed; }
  .month-step:focus-visible, .caveat-link:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
  .month-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .month-picker select { min-height: 36px; padding: 0 34px 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); }

  .month-reading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: var(--space-5); align-items: start; margin: var(--space-6) 0 var(--space-4); }
  .month-figure { display: grid; gap: var(--space-2); min-width: 0; }
  .month-figure > .money { font-size: clamp(22px, 2.5vw, 32px); font-weight: 750; line-height: 1.1; letter-spacing: -0.02em; }
  .month-standing, .month-usual-range { margin: 0; font-size: 14px; line-height: 1.5; }
  .month-standing strong { margin-right: var(--space-2); font-weight: 700; }
  .month-standing[data-standing="above"] strong { color: var(--warn); }
  .month-usual-range, .standing-difference { color: var(--muted); }
  .month-usual-range .money, .standing-difference .money { white-space: nowrap; }
  .month-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border: 1px solid var(--border); border-radius: var(--radius); }
  .month-facts > div { min-width: 0; padding: var(--space-3); }
  .month-facts > div:nth-child(even) { border-left: 1px solid var(--border); }
  .month-facts > div:nth-child(n + 3) { border-top: 1px solid var(--border); }
  .month-facts dt { color: var(--muted); font-size: 11px; font-weight: 720; letter-spacing: 0.075em; text-transform: uppercase; }
  .month-facts dd { margin: 4px 0 0; font-size: 18px; font-weight: 750; }
  .month-facts .fact-sub { margin-top: 2px; color: var(--muted); font-size: 12px; font-weight: 400; }
  .month-facts .fact-sub .money { white-space: nowrap; }

  .month-caveat { margin: 0 0 var(--space-3); color: var(--muted); font-size: 13px; }
  .month-caveat.caution { color: var(--warn); }
  .caveat-link { margin-left: var(--space-2); padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--accent); font: inherit; font-weight: 680; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .month-chart-pending { min-height: 340px; border-radius: 12px; background: var(--surface-soft); }
  .trend-chart-pending { min-height: 240px; border-radius: 12px; background: var(--surface-soft); }
  .day-detail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); margin-top: var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; }
  .day-detail > span { color: var(--muted); }
  .day-detail > .money { color: var(--fg); font-weight: 750; }
  .day-detail .button { min-height: 32px; margin-left: auto; }
  .chart-footer { display: flex; align-items: center; justify-content: space-between; flex-direction: row-reverse; gap: var(--space-4); margin-top: var(--space-3); }
  .chart-period-picker { display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font-size: 11px; }
  .chart-period-picker select { min-height: 32px; max-width: 210px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; }
  .chart-hint { margin: 0; color: var(--muted); font-size: 11px; }
  .month-footnotes { display: grid; gap: 2px; margin-top: var(--space-3); color: var(--muted); font-size: 12px; }
  .month-footnotes p, .month-empty { margin: 0; }
  .month-empty { padding: var(--space-8) 0; color: var(--muted); text-align: center; }
  .spending-trend-card h2 { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; }
  .trend-currency { margin: 4px 0 var(--space-3); color: var(--muted); font-size: 12px; }
  .purchase-canonical-note { margin: var(--space-4) 0 0; color: var(--muted); font-size: 12px; }

  .purchase-candidates-card { display: grid; gap: var(--space-4); }
  .candidate-scope { display: flex; align-items: center; gap: var(--space-3); color: var(--muted); font-size: 12px; }
  .candidate-list { display: grid; }
  .candidate-empty { margin: 0; padding: var(--space-5); border-radius: var(--radius); background: var(--surface-soft); color: var(--muted); text-align: center; }
  .candidate-row { display: grid; grid-template-columns: minmax(0, 1fr) 116px minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-top: 1px solid var(--border); }
  .candidate-side { display: grid; gap: 3px; min-width: 0; }
  .candidate-side strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .candidate-side > span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .candidate-compare { position: relative; display: grid; gap: 2px; justify-items: center; color: var(--muted); font-size: 10px; text-align: center; }
  .candidate-compare::before { content: ""; position: absolute; top: 50%; left: -12px; right: -12px; z-index: 0; height: 1px; background: var(--border); }
  .candidate-compare span { position: relative; z-index: 1; padding: 1px 6px; background: var(--surface); }
  .candidate-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: end; }
  .show-more-candidates { width: 100%; margin-top: var(--space-2); }

  .purchase-records-card { padding-bottom: 0; overflow: hidden; }
  .records-heading { padding-bottom: var(--space-4); }
  .purchase-record-list { margin-inline: calc(var(--space-5) * -1); }
  .purchase-day-group { border-top: 1px solid var(--border); }
  .purchase-day-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) var(--space-5); background: var(--surface-soft); }
  .purchase-day-heading > div { display: flex; align-items: baseline; gap: var(--space-3); }
  .purchase-day-heading strong { font-size: 13px; }
  .purchase-day-heading span { color: var(--muted); font-size: 11px; }
  .day-totals { flex-wrap: wrap; justify-content: flex-end; }
  .day-totals .money { color: var(--fg); font-size: 12px; font-weight: 700; }
  .purchase-record { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--space-5); padding: var(--space-4) var(--space-5); border-top: 1px solid color-mix(in oklch, var(--border) 70%, transparent); }
  .purchase-record.possible { background: color-mix(in oklch, var(--danger) 4%, white); }
  .purchase-record-main { min-width: 0; display: grid; gap: 5px; }
  .purchase-record-main > span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .purchase-record-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
  .purchase-record-heading > strong { font-size: 13px; }
  .purchase-basis, .possible-duplicate { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--muted); font-size: 10px; }
  .possible-duplicate { background: color-mix(in oklch, var(--danger) 8%, white); color: var(--danger); }
  .fallback-date { color: var(--warn) !important; font-weight: 700; }
  .purchase-record-side { text-align: right; white-space: nowrap; }
  .purchase-record-side strong { font-size: 14px; }
  .item-list, .source-details { color: var(--muted); font-size: 12px; }
  .item-list summary, .source-details summary { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--accent); list-style: none; }
  .item-list summary::-webkit-details-marker, .source-details summary::-webkit-details-marker { display: none; }
  .item-list summary::before, .source-details summary::before { content: ""; width: 5px; height: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 180ms ease; }
  .item-list[open] > summary::before, .source-details[open] > summary::before { transform: rotate(45deg); }
  .item-list > span { display: block; margin-top: 4px; }
  .source-details pre { max-width: 100%; margin: 5px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .revoke-button, .pair-button { justify-self: start; margin-top: 4px; }
  .refund-note { color: var(--success) !important; }
  .purchase-empty { display: grid; gap: 5px; padding: var(--space-8) var(--space-5); color: var(--muted); text-align: center; }
  .purchase-empty strong { color: var(--fg); }

  .pairing-dialog-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: var(--space-5); background: rgba(14, 18, 28, 0.44); -webkit-backdrop-filter: blur(10px) saturate(0.84); backdrop-filter: blur(10px) saturate(0.84); }
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
  .candidate-empty.pairing-loading { display: flex; justify-content: center; }
  @media (prefers-reduced-motion: reduce) {
    .item-list summary::before, .source-details summary::before, .purchase-basis-banner summary::after { transition: none; }
  }

  @media (max-width: 1050px) {
    .purchase-analysis-grid { grid-template-columns: 1fr; }
    .month-reading { grid-template-columns: 1fr; }
    .month-facts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .month-facts > div:nth-child(n + 2) { border-left: 1px solid var(--border); border-top: 0; }
    .candidate-row { grid-template-columns: minmax(0, 1fr) 96px minmax(0, 1fr); }
    .candidate-actions { grid-column: 1 / -1; justify-content: start; }
  }
  @media (max-width: 680px) {
    .section-heading { align-items: flex-start; flex-direction: column; }
    .purchase-basis-banner summary { flex-wrap: wrap; }
    .month-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .month-facts > div:nth-child(odd) { border-left: 0; }
    .month-facts > div:nth-child(n + 3) { border-top: 1px solid var(--border); }
    .day-detail .button { margin-left: 0; }
    .candidate-scope { width: 100%; justify-content: space-between; }
    .candidate-row { grid-template-columns: 1fr; }
    .candidate-compare { justify-items: start; text-align: left; }
    .candidate-compare::before { display: none; }
    .candidate-compare span { padding-left: 0; }
    .purchase-record { grid-template-columns: 1fr; gap: var(--space-2); }
    .purchase-record-side { text-align: left; }
    .purchase-day-heading { align-items: flex-start; }
    .purchase-day-heading, .purchase-day-heading > div { flex-direction: column; gap: 3px; }
    .chart-footer, .chart-period-picker { align-items: stretch; flex-direction: column; }
    .chart-period-picker select { max-width: none; width: 100%; }
  }
</style>
