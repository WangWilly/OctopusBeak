<script lang="ts">
  import { onMount } from "svelte";
  import { createSpendingPageReader } from "../page-reader.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { exactToNumber } from "$lib/shared-money/exact.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";
  import { resolveSpendingPurchaseReport } from "$lib/shared-shell/progressive-dashboard-data.ts";
  import {
    type SpendingPurchaseRecordView as PurchaseRecord,
    type SpendingPurchaseReportView,
  } from "../purchase-matching.ts";
  import {
    reconcileSpendingPageActionSummary,
    spendingPairingReportContext,
    type SpendingCandidatePageDto,
    type SpendingPageDto,
    type SpendingPageActionResult,
    type SpendingPairingCandidateView,
    type SpendingPurchaseReportSummaryDto,
    type SpendingRecordPageDto,
    preserveSpendingMonthSelection,
  } from "../model.ts";
  import { applySpendingPurchaseReportPatch } from "../purchase-report-patch.ts";
  import PurchaseActivityBarChart, {
    type PurchaseActivityDatum,
  } from "./PurchaseActivityBarChart.svelte";

  type PurchaseReport = SpendingPurchaseReportView & Readonly<{ summary?: SpendingPurchaseReportSummaryDto }>;

  export let purchaseReport: PurchaseReport;
  export let fallbackCanonical: SpendingPageDto["canonical"];
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let refreshSummary: () => Promise<void> = async () => {};
  const pageReader = createSpendingPageReader(() => refreshSummary());

  export let retryBlock: (key: string) => void = () => {};

  function blockState(key: "summary" | "chart" | "list" | "details"): BlockState<DashboardBlockPayload> {
    if (report.summary) {
      const data = {
        canonical: fallbackCanonical,
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
  let pendingReport: PurchaseReport | null = null;
  let previousReport: PurchaseReport | undefined;
  let selectedMonth: string | null = null;
  let chartReady = false;
  let busyAction: string | null = null;
  let actionError = "";
  let pairingFeedback = "";
  let pairingInvoice: PurchaseRecord | null = null;
  let selectedPaymentId = "";
  let paymentVisibleCount = 10;
  let candidateVisibleCount = 10;
  let previousCandidateKey = "";
  let chartMode: "day" | "month" = "day";
  let selectedCurrency = "";
  let selectedDay: string | null = null;
  let monthCandidateCount: number | null = null;
  let monthCandidateLoading = false;
  let recordPageLoading = false;
  let recordPageNextCursor: string | null = null;
  let recordPageRecords: readonly PurchaseRecord[] = [];
  let candidatePageItems: SpendingCandidatePageDto["items"] = [];
  let candidatePageNextOffset: number | null = null;
  let candidatePageMonthKey = "";
  let candidatePageRequestId: string | null = null;
  let candidatePageTimer: ReturnType<typeof setTimeout> | null = null;
  let recordRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRecordRefresh: Readonly<{
    knowledgeAt: number;
    month: string;
    day: string | null;
    key: string;
    requestToken: number;
  }> | null = null;
  let monthDataRequestToken = 0;
  let candidatePageRequestToken = 0;
  let requestedMonthDataKey = "";
  let loadedMonthDataKey = "";
  let pageError = "";
  let nextCandidateRequestId = 1;
  let pairingCandidates: readonly SpendingPairingCandidateView[] | null = null;
  let validatedSelectedCandidate: SpendingPairingCandidateView | null = null;
  let pairingDataVersion: number | null = null;
  let pairingCandidateTotal = 0;
  let pairingNextOffset: number | null = null;
  let pairingCandidatesLoading = false;
  let pairingRequestToken = 0;
  let pairingPrewarmVersion: number | null = null;
  const initialPairingCandidateCount = 50;
  const reportDerivedCache = new WeakMap<object, {
    months: readonly string[];
    availableCurrencies: readonly string[];
    monthTotals: ReturnType<typeof totalsByMonthFor>;
    pendingCandidates: PurchaseReport["candidates"];
    candidateRecordsByKey: Map<string, PurchaseRecord>;
  }>();
  const reportRecordsCache = new WeakMap<object, Map<string, PurchaseRecord[]>>();
  const reportVisibleRecordsCache = new WeakMap<object, Map<string, PurchaseRecord[]>>();

  onMount(() => {
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
      if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
      pendingRecordRefresh = null;
      monthDataRequestToken += 1;
      void cancelPendingCandidatePage();
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
      monthTotals: totalsByMonthFor(sourceReport),
      pendingCandidates: sourceReport.candidates.filter((candidate) => candidate.status === "candidate"),
      candidateRecordsByKey: candidateRecordsByKeyFor(sourceReport),
    };
    reportDerivedCache.set(sourceReport, derived);
    return derived;
  }

  $: if (previousReport !== purchaseReport) {
    const sameVersionUpdate = Boolean(previousReport && report.summary && purchaseReport.summary
      && report.knowledgeAt === purchaseReport.knowledgeAt);
    const selection = preserveSpendingMonthSelection(
      previousReport?.summary,
      purchaseReport.summary,
      selectedMonth,
      selectedDay,
    );
    previousReport = purchaseReport;
    selectedMonth = selection.selectedMonth;
    selectedDay = selection.selectedDay;
    actionError = "";
    if (sameVersionUpdate) {
      // The compact action result already advanced this version locally. The
      // same-version live publication confirms its summary without discarding
      // the immediately patched affected row or launching a duplicate page.
      report = Object.freeze({
        ...purchaseReport,
        records: report.records,
        candidates: report.candidates,
      });
      // An explicit summary reload can retry a failed page even when no new
      // financial commit was made. The failure itself never resets this key.
      if (pageError) resetMonthPageState(true);
    } else {
      const retainSnapshot = Boolean(report.summary && report.records.length > 0 && purchaseReport.summary);
      pendingReport = retainSnapshot ? purchaseReport : null;
      if (!retainSnapshot) report = purchaseReport;
      resetMonthPageState(retainSnapshot);
    }
  }
  $: if (pairingInvoice?.invoice) {
    const latestVersion = (pendingReport ?? report).knowledgeAt;
    // The retained list is a display snapshot. Candidate eligibility follows
    // the latest summary immediately, even while its record page is loading.
    const currentInvoice = pendingReport ? pairingInvoice : report.records.find((record) =>
      record.basis === "invoice" && record.invoice?.invoiceId === pairingInvoice?.invoice?.invoiceId);
    if (!currentInvoice) {
      closePairing();
      actionError = $t.purchaseSpending.pairingInvoiceUnavailable;
    } else {
      if (pairingInvoice !== currentInvoice) pairingInvoice = currentInvoice;
      if (pairingDataVersion !== latestVersion) {
        pairingDataVersion = latestVersion;
        pairingCandidates = null;
        validatedSelectedCandidate = null;
        pairingCandidateTotal = 0;
        pairingNextOffset = null;
        paymentVisibleCount = initialPairingCandidateCount;
        pairingCandidatesLoading = true;
        void loadPairingCandidates(currentInvoice, ++pairingRequestToken);
      }
    }
  }
  // Candidate preparation stays in the financial worker.  Fire it once for
  // each immutable report version without delaying the shell or renderer.
  $: if (report.knowledgeAt !== pairingPrewarmVersion) {
    const dataVersion = report.knowledgeAt;
    pairingPrewarmVersion = dataVersion;
    void window.octopusBeak.spending.prewarmPairingCandidates({ dataVersion }).catch(() => {});
  }
  $: reportDerived = reportDerivedFor(report);
  $: months = reportDerived.months;
  $: activeMonth = selectedMonth ?? months.at(-1) ?? null;
  $: pageReader.observe((pendingReport ?? report).knowledgeAt);
  $: if ((pendingReport ?? report).summary && activeMonth) {
    const nextReport = pendingReport ?? report;
    const key = `${nextReport.knowledgeAt}:${activeMonth}:${selectedDay ?? ""}`;
    if (key !== requestedMonthDataKey && key !== loadedMonthDataKey)
      void loadMonthData(nextReport.knowledgeAt, activeMonth, key);
  }
  $: monthRecords = recordsForMonth(report, activeMonth);
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
  $: candidateKey = `${report.knowledgeAt}:${activeMonth ?? ""}:${monthCandidateCount ?? "unloaded"}`;
  $: if (candidateKey !== previousCandidateKey) {
    previousCandidateKey = candidateKey;
    candidateVisibleCount = Math.min(10, visibleCandidates.length);
  }
  $: visibleCandidateRows = visibleCandidates.slice(0, candidateVisibleCount);
  $: visibleEligiblePayments = [
    ...(validatedSelectedCandidate && selectedPaymentId === validatedSelectedCandidate.transactionId &&
      !(pairingCandidates ?? []).slice(0, paymentVisibleCount).some((candidate) => candidate.transactionId === selectedPaymentId)
      ? [validatedSelectedCandidate] : []),
    ...(pairingCandidates ?? []).slice(0, paymentVisibleCount),
  ];
  $: selectedPayment = pairingCandidates?.find((candidate) => candidate.transactionId === selectedPaymentId)
    ?? (validatedSelectedCandidate?.transactionId === selectedPaymentId ? validatedSelectedCandidate : null);
  $: monthTotals = reportDerived.monthTotals;
  $: visibleTotals = totalsForPeriod(report, activeMonth, selectedDay);
  $: selectedMonthTotal = visibleTotals.find((amount) => amount.currency === selectedCurrency) ?? null;
  $: monthSummary = report.summary?.monthTotals.find((summary) => summary.month === activeMonth) ?? null;
  $: periodRecordCount = report.summary
    ? selectedDay
      ? report.summary.dayTotals.find((summary) => summary.date === selectedDay)?.recordCount ?? 0
      : monthSummary?.recordCount ?? 0
    : visibleRecords.length;
  $: spendingDayCount = selectedDay
    ? 1
    : monthSummary?.activeDayCount ?? new Set(monthRecords.map((record) => record.occurrence.value.slice(0, 10))).size;
  $: recordGroups = groupRecordsByDate(visibleRecords);
  $: chartData = chartMode === "day"
    ? dailyChartDataFor(report, monthRecords, activeMonth, selectedCurrency)
    : monthlyChartData(monthTotals, selectedCurrency);
  $: candidateRecordsByKey = reportDerived.candidateRecordsByKey;

  function cancelPendingCandidatePage(): Promise<void> {
    const pendingTimer = candidatePageTimer;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    candidatePageTimer = null;
    candidatePageRequestToken += 1;
    monthCandidateLoading = false;
    const requestId = candidatePageRequestId;
    candidatePageRequestId = null;
    if (requestId && typeof window !== "undefined") {
      return window.octopusBeak.spending.cancelCandidatePage(requestId).then(() => undefined, () => undefined);
    }
    return Promise.resolve();
  }

  function resetMonthPageState(retainSnapshot = false) {
    cancelPendingRecordRefresh();
    monthDataRequestToken += 1;
    void cancelPendingCandidatePage();
    requestedMonthDataKey = "";
    loadedMonthDataKey = "";
    candidatePageMonthKey = "";
    recordPageLoading = false;
    recordPageNextCursor = null;
    if (!retainSnapshot) {
      recordPageRecords = [];
      candidatePageItems = [];
    }
    candidatePageNextOffset = null;
    monthCandidateCount = null;
    pageError = "";
  }

  function publishMonthPageRecords() {
    if (!report.summary) return;
    const byId = new Map<string, PurchaseRecord>();
    for (const record of [...recordPageRecords, ...candidatePageItems.flatMap((item) => [item.invoiceRecord, item.paymentRecord].filter((value): value is PurchaseRecord => value !== null))]) {
      const prior = byId.get(record.purchaseId);
      if (!prior) {
        byId.set(record.purchaseId, record);
        continue;
      }
      byId.set(record.purchaseId, Object.freeze({
        ...prior,
        candidateIds: Object.freeze([...new Set([...prior.candidateIds, ...record.candidateIds])]),
        possibleDuplicate: prior.possibleDuplicate || record.possibleDuplicate,
      }));
    }
    const records = [...byId.values()].sort((left, right) =>
      right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
    const candidates = candidatePageItems.map((item) => item.candidate);
    const summary = Object.freeze({
      ...report.summary,
      monthTotals: Object.freeze(report.summary.monthTotals.map((month) => month.month === activeMonth && monthCandidateCount !== null
        ? Object.freeze({ ...month, pendingCandidateCount: monthCandidateCount })
        : month)),
    });
    report = Object.freeze({
      ...report,
      records: Object.freeze(records),
      candidates: Object.freeze(candidates),
      summary,
    });
  }

  async function loadMonthData(knowledgeAt: number, month: string, key: string) {
    if (requestedMonthDataKey === key || loadedMonthDataKey === key) return;
    requestedMonthDataKey = key;
    const requestToken = ++monthDataRequestToken;
    const candidateKeyForMonth = `${knowledgeAt}:${month}`;
    const replaceCandidates = candidatePageMonthKey !== candidateKeyForMonth;
    if (replaceCandidates) {
      await cancelPendingCandidatePage();
      if (requestToken !== monthDataRequestToken) return;
      candidatePageMonthKey = candidateKeyForMonth;
      candidatePageNextOffset = null;
      monthCandidateCount = null;
    }
    recordPageLoading = true;
    pageError = "";
    try {
      const page: SpendingRecordPageDto | null = await pageReader.read(knowledgeAt, () => window.octopusBeak.spending.loadRecordPage({
        knowledgeAt,
        month,
        day: selectedDay && selectedDay.startsWith(`${month}-`) ? selectedDay : null,
        limit: 50,
      }));
      if (!page) return;
      if (requestToken !== monthDataRequestToken || (pendingReport ?? report).knowledgeAt !== knowledgeAt || activeMonth !== month) return;
      if (pendingReport) {
        report = pendingReport;
        pendingReport = null;
      }
      if (replaceCandidates) candidatePageItems = [];
      recordPageRecords = page.records;
      recordPageNextCursor = page.nextCursor;
      loadedMonthDataKey = key;
      publishMonthPageRecords();
      scheduleCandidatePageLoad(knowledgeAt, month, candidateKeyForMonth);
    } catch (error) {
      if (requestToken === monthDataRequestToken) {
        pageError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestToken === monthDataRequestToken) recordPageLoading = false;
    }
  }

  function scheduleCandidatePageLoad(knowledgeAt: number, month: string, key: string) {
    if (pairingInvoice || monthCandidateCount !== null || candidatePageTimer !== null || candidatePageRequestId !== null) return;
    candidatePageTimer = setTimeout(() => {
      candidatePageTimer = null;
      void fetchCandidatePage(knowledgeAt, month, key, 0);
    }, 1_200);
  }

  async function fetchCandidatePage(knowledgeAt: number, month: string, key: string, offset: number) {
    if (pairingInvoice || candidatePageMonthKey !== key || report.knowledgeAt !== knowledgeAt) return;
    const requestToken = ++candidatePageRequestToken;
    const requestId = `spending-candidates-${nextCandidateRequestId++}`;
    candidatePageRequestId = requestId;
    monthCandidateLoading = true;
    try {
      const page: SpendingCandidatePageDto | null = await pageReader.read(knowledgeAt, () => window.octopusBeak.spending.loadCandidatePage({
        knowledgeAt,
        month,
        offset,
        limit: 50,
      }, requestId));
      if (!page) return;
      if (requestToken !== candidatePageRequestToken || pairingInvoice || report.knowledgeAt !== knowledgeAt || activeMonth !== month) return;
      candidatePageItems = offset === 0 ? page.items : Object.freeze([...candidatePageItems, ...page.items]);
      candidatePageNextOffset = page.nextOffset;
      monthCandidateCount = page.totalCandidateCount;
      publishMonthPageRecords();
    } catch (error) {
      if (requestToken === candidatePageRequestToken) {
        pageError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (candidatePageRequestId === requestId) candidatePageRequestId = null;
      if (requestToken === candidatePageRequestToken) monthCandidateLoading = false;
    }
  }

  async function loadMoreRecords() {
    if (!recordPageNextCursor || !activeMonth || !report.summary || recordPageLoading) return;
    const knowledgeAt = report.knowledgeAt;
    const month = activeMonth;
    const requestToken = monthDataRequestToken;
    recordPageLoading = true;
    try {
      const page: SpendingRecordPageDto | null = await pageReader.read(knowledgeAt, () => window.octopusBeak.spending.loadRecordPage({
        knowledgeAt,
        month,
        day: selectedDay && selectedDay.startsWith(`${month}-`) ? selectedDay : null,
        cursor: recordPageNextCursor,
        limit: 50,
      }));
      if (!page) return;
      if (requestToken !== monthDataRequestToken || report.knowledgeAt !== knowledgeAt || activeMonth !== month) return;
      recordPageRecords = Object.freeze([...recordPageRecords, ...page.records]);
      recordPageNextCursor = page.nextCursor;
      publishMonthPageRecords();
    } catch (error) {
      if (requestToken === monthDataRequestToken && report.knowledgeAt === knowledgeAt && activeMonth === month)
        pageError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === monthDataRequestToken) recordPageLoading = false;
    }
  }

  async function showMoreCandidates() {
    const nextCount = candidateVisibleCount + 10;
    if (nextCount > visibleCandidates.length && candidatePageNextOffset !== null && activeMonth && report.summary) {
      await fetchCandidatePage(report.knowledgeAt, activeMonth, candidatePageMonthKey, candidatePageNextOffset);
    }
    candidateVisibleCount = Math.min(nextCount, monthCandidateCount ?? visibleCandidates.length);
  }

  function acceptCompactPageAction(result: SpendingPageActionResult) {
    // An action may finish after a newer live publication. Preserve that
    // publication and its in-flight page instead of promoting an older result.
    if ((pendingReport ?? report).knowledgeAt > result.knowledgeAt) return;
    if (!report.summary) {
      if (report.knowledgeAt >= result.knowledgeAt) return;
      throw new Error("Spending changed while applying the pairing result. Reload the selected month.");
    }
    const reconciliation = reconcileSpendingPageActionSummary(report.summary, report.knowledgeAt, result);
    if (reconciliation.state === "newer-live-version") return;
    const liveAlreadyPublishedAction = reconciliation.state === "already-current";
    const month = activeMonth;
    const day = selectedDay && month && selectedDay.startsWith(`${month}-`) ? selectedDay : null;
    const summary = reconciliation.summary;
    const matchesPair = (record: PurchaseRecord) =>
      record.invoice?.invoiceId === result.invoiceIdentityId ||
      record.transaction?.transactionId === result.transactionIdentityId;
    const matchesView = (record: PurchaseRecord) =>
      (month === null || record.occurrence.value.startsWith(`${month}-`))
      && (day === null || record.occurrence.value.startsWith(day));
    const nextRecords = Object.freeze([
      ...recordPageRecords.filter((record) => !matchesPair(record)),
      ...result.affectedRecords.filter((record) => matchesView(record as PurchaseRecord)),
    ].sort((left, right) =>
      right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId)));
    const nextReport = Object.freeze({
      ...report,
      knowledgeAt: result.knowledgeAt,
      totalsByCurrency: summary.totalsByCurrency,
      summary,
      records: nextRecords,
      candidates: Object.freeze([]),
    }) as PurchaseReport;
    const monthKey = month ? `${result.knowledgeAt}:${month}:${day ?? ""}` : "";
    const currentPageRequestPending = liveAlreadyPublishedAction
      && requestedMonthDataKey === monthKey
      && loadedMonthDataKey !== monthKey;
    if (!liveAlreadyPublishedAction) monthDataRequestToken += 1;
    const requestToken = monthDataRequestToken;
    void cancelPendingCandidatePage();
    candidatePageItems = [];
    candidatePageNextOffset = null;
    candidatePageMonthKey = month ? `${result.knowledgeAt}:${month}` : "";
    monthCandidateCount = null;
    recordPageRecords = nextRecords;
    recordPageNextCursor = null;
    if (!liveAlreadyPublishedAction) {
      recordPageLoading = Boolean(month);
      requestedMonthDataKey = monthKey;
      loadedMonthDataKey = "";
    }
    pageError = "";
    pendingReport = null;
    report = nextReport;
    selectedMonth = month;
    fallbackCanonical = Object.freeze({
      ...fallbackCanonical,
      availability: summary.recordCount > 0 ? "available" : "empty",
      knowledgePoint: result.knowledgeAt,
      totalsByCurrency: summary.totalsByCurrency.map((amount) => ({
        currency: amount.currency,
        value: exactToNumber(amount),
        exact: { coefficient: amount.coefficient, scale: amount.scale },
      })),
      totalStatus: "complete",
    });
    if (month && liveAlreadyPublishedAction && !currentPageRequestPending) {
      recordPageLoading = true;
      scheduleRecordRefreshAfterAction(result.knowledgeAt, month, day, monthKey, requestToken);
    } else if (month && !liveAlreadyPublishedAction) {
      scheduleRecordRefreshAfterAction(result.knowledgeAt, month, day, monthKey, requestToken);
    }
  }

  function scheduleRecordRefreshAfterAction(
    knowledgeAt: number,
    month: string,
    day: string | null,
    key: string,
    requestToken: number,
  ) {
    pendingRecordRefresh = { knowledgeAt, month, day, key, requestToken };
    if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
    // The action result already patches affected rows and summary. Give a
    // subsequent Pairing click priority over this full page reconciliation.
    recordRefreshTimer = setTimeout(() => {
      recordRefreshTimer = null;
      flushRecordRefreshAfterAction();
    }, 1_200);
  }

  function cancelPendingRecordRefresh() {
    const hadPending = pendingRecordRefresh !== null;
    if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
    recordRefreshTimer = null;
    pendingRecordRefresh = null;
    if (hadPending) recordPageLoading = false;
  }

  function flushRecordRefreshAfterAction() {
    if (pairingInvoice || !pendingRecordRefresh) return;
    if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
    recordRefreshTimer = null;
    const request = pendingRecordRefresh;
    pendingRecordRefresh = null;
    void refreshRecordsAfterAction(
      request.knowledgeAt, request.month, request.day, request.key, request.requestToken,
    );
  }

  async function refreshRecordsAfterAction(
    knowledgeAt: number,
    month: string,
    day: string | null,
    key: string,
    requestToken: number,
  ) {
    try {
      const page: SpendingRecordPageDto | null = await pageReader.read(knowledgeAt, () => window.octopusBeak.spending.loadRecordPage({
        knowledgeAt,
        month,
        day,
        limit: 50,
      }));
      if (!page) return;
      if (requestToken !== monthDataRequestToken || report.knowledgeAt !== knowledgeAt || activeMonth !== month) return;
      recordPageRecords = page.records;
      recordPageNextCursor = page.nextCursor;
      loadedMonthDataKey = key;
      publishMonthPageRecords();
      scheduleCandidatePageLoad(knowledgeAt, month, `${knowledgeAt}:${month}`);
    } catch (error) {
      if (requestToken === monthDataRequestToken && report.knowledgeAt === knowledgeAt && activeMonth === month)
        pageError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === monthDataRequestToken) recordPageLoading = false;
    }
  }

  function moneyValue(amount: { coefficient: string; scale: number; currency: string }) {
    return {
      currency: amount.currency,
      value: exactToNumber(amount),
      exact: { coefficient: amount.coefficient, scale: amount.scale },
    };
  }

  function amountText(amount: { coefficient: string; scale: number; currency: string } | null, signed = false) {
    if (!amount) return $t.purchaseSpending.amountUnavailable;
    return formatMoney(moneyValue(amount), { locale: $locale, signed });
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

  function chartDataFor(
    sourceReport: PurchaseReport,
    mode: "day" | "month",
    preferredMonth: string | null,
    currency: string,
  ) {
    const active = activeMonthForReport(sourceReport, preferredMonth);
    return mode === "day"
      ? dailyChartDataFor(sourceReport, sourceReport.records, active, currency)
      : monthlyChartData(totalsByMonthFor(sourceReport), currency);
  }

  function currenciesForReport(sourceReport: PurchaseReport) {
    return sourceReport.summary?.currencies
      ?? [...new Set(sourceReport.records.flatMap((record) => record.amount ? [record.amount.currency] : []))].sort();
  }

  function totalsByMonthFor(sourceReport: PurchaseReport) {
    return sourceReport.summary
      ? sourceReport.summary.monthTotals.flatMap((month) => month.totalsByCurrency.map((amount) => ({ month: month.month, amount })))
      : totalsByMonth(sourceReport.records);
  }

  function totalsForPeriod(sourceReport: PurchaseReport, month: string | null, day: string | null) {
    if (sourceReport.summary) {
      if (day) return sourceReport.summary.dayTotals.find((row) => row.date === day)?.totalsByCurrency ?? [];
      return sourceReport.summary.monthTotals.find((row) => row.month === month)?.totalsByCurrency ?? [];
    }
    return totalsByCurrency(day
      ? sourceReport.records.filter((record) => record.occurrence.value.startsWith(day))
      : sourceReport.records.filter((record) => month === null || record.occurrence.value.startsWith(`${month}-`)));
  }

  function dailyChartDataFor(
    sourceReport: PurchaseReport,
    records: readonly PurchaseRecord[],
    month: string | null,
    currency: string,
  ) {
    if (sourceReport.summary && month) {
      const [year, monthNumber] = month.split("-").map(Number);
      if (!year || !monthNumber) return [];
      const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const totals = new Map(sourceReport.summary.dayTotals
        .filter((row) => row.month === month)
        .flatMap((row) => row.totalsByCurrency
          .filter((amount) => amount.currency === currency)
          .map((amount) => [row.date, exactToNumber(amount)] as const)));
      return Array.from({ length: days }, (_, index) => {
        const date = `${month}-${String(index + 1).padStart(2, "0")}`;
        const value = totals.get(date) ?? 0;
        return { key: date, label: `${monthNumber}/${index + 1}`, value, tone: value < 0 ? "refund" as const : "spend" as const };
      });
    }
    return dailyChartData(records, month, currency);
  }

  function totalsByMonth(records: readonly PurchaseRecord[]) {
    const totals = new Map<string, { coefficient: string; scale: number; currency: string; count: number }>();
    for (const record of records) {
      if (!record.amount) continue;
      const key = `${record.occurrence.value.slice(0, 7)}|${record.amount.currency}`;
      const previous = totals.get(key);
      if (!previous) {
        totals.set(key, { ...record.amount, count: 1 });
        continue;
      }
      const scale = Math.max(previous.scale, record.amount.scale);
      const coefficient = BigInt(previous.coefficient) * 10n ** BigInt(scale - previous.scale) +
        BigInt(record.amount.coefficient) * 10n ** BigInt(scale - record.amount.scale);
      totals.set(key, { currency: record.amount.currency, coefficient: coefficient.toString(), scale, count: previous.count + 1 });
    }
    return [...totals.entries()]
      .map(([key, amount]) => ({ month: key.slice(0, key.indexOf("|")), amount }))
      .sort((left, right) => left.month.localeCompare(right.month) || left.amount.currency.localeCompare(right.amount.currency));
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

  function dailyChartData(
    records: readonly PurchaseRecord[],
    month: string | null,
    currency: string,
  ): PurchaseActivityDatum[] {
    if (!month) return [];
    const [year, monthNumber] = month.split("-").map(Number);
    if (!year || !monthNumber) return [];
    const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const totals = new Map<string, number>();
    for (const record of records) {
      if (!record.amount || record.amount.currency !== currency) continue;
      const date = record.occurrence.value.slice(0, 10);
      totals.set(date, (totals.get(date) ?? 0) + exactToNumber(record.amount));
    }
    return Array.from({ length: days }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      const key = `${month}-${day}`;
      const value = totals.get(key) ?? 0;
      return { key, label: `${monthNumber}/${index + 1}`, value, tone: value < 0 ? "refund" : "spend" };
    });
  }

  function monthlyChartData(
    rows: ReturnType<typeof totalsByMonth>,
    currency: string,
  ): PurchaseActivityDatum[] {
    return rows
      .filter((row) => row.amount.currency === currency)
      .map((row) => ({
        key: row.month,
        label: row.month.slice(2).replace("-", "/"),
        value: exactToNumber(row.amount),
        tone: exactToNumber(row.amount) < 0 ? "refund" as const : "spend" as const,
      }));
  }

  function chooseMonth(month: string) {
    selectedMonth = month;
    selectedDay = null;
  }

  function selectChartPeriod(key: string) {
    if (chartMode === "month") {
      chooseMonth(key);
      chartMode = "day";
      return;
    }
    selectedDay = selectedDay === key ? null : key;
  }

  function selectChartPeriodFromControl(key: string) {
    if (chartMode === "day") {
      selectedDay = key || null;
      return;
    }
    if (key) selectChartPeriod(key);
  }

  async function confirmCandidate(candidateId: string) {
    await decideCandidate(candidateId, "confirmCandidate");
  }

  async function denyCandidate(candidateId: string) {
    await decideCandidate(candidateId, "denyCandidate");
  }

  async function decideCandidate(candidateId: string, action: "confirmCandidate" | "denyCandidate") {
    cancelPendingRecordRefresh();
    busyAction = `${action}:${candidateId}`;
    actionError = "";
    try {
      const candidate = report.candidates.find((entry) => entry.candidateId === candidateId);
      const recordsByKey = candidateRecordsByKeyFor(report);
      const invoiceRecord = candidate ? recordsByKey.get(`${candidate.candidateId}:invoice`) ?? null : null;
      const paymentRecord = candidate ? recordsByKey.get(`${candidate.candidateId}:transaction`) ?? null : null;
      if (report.summary) {
        if (!candidate || !invoiceRecord?.invoice || !paymentRecord?.transaction)
          throw new Error($t.purchaseSpending.pairingSelectionUnavailable);
        const result = await window.octopusBeak.spending.applyPageAction({
          action: action === "confirmCandidate" ? "confirm" : "deny",
          kind: "candidate",
          candidateId,
          invoiceIdentityId: invoiceRecord.invoice.invoiceId,
          transactionIdentityId: paymentRecord.transaction.transactionId,
          dataVersion: report.knowledgeAt,
        });
        acceptCompactPageAction(result);
        selectedMonth = activeMonth;
        return;
      }
      const context = candidate && invoiceRecord && paymentRecord
        ? spendingPairingReportContext(report, invoiceRecord, paymentRecord, candidateId) : null;
      const request = candidate && context ? {
        kind: "candidate" as const, candidateId,
        invoiceIdentityId: invoiceRecord!.invoice!.invoiceId,
        transactionIdentityId: paymentRecord!.transaction!.transactionId,
        dataVersion: report.knowledgeAt,
        totalsByCurrency: report.totalsByCurrency,
        pairingReportContext: context,
      } : { kind: "candidate" as const, candidateId };
      const next = action === "confirmCandidate"
        ? await window.octopusBeak.spending.confirmCandidate(request)
        : await window.octopusBeak.spending.denyCandidate(request);
      report = applySpendingPurchaseReportPatch(report, next.patch);
      selectedMonth = activeMonth;
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      busyAction = null;
    }
  }


  function openPairing(record: PurchaseRecord) {
    if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
    recordRefreshTimer = null;
    pairingInvoice = record;
    pairingDataVersion = report.knowledgeAt;
    selectedPaymentId = "";
    pairingFeedback = "";
    validatedSelectedCandidate = null;
    paymentVisibleCount = initialPairingCandidateCount;
    pairingCandidates = null;
    pairingCandidateTotal = 0;
    pairingNextOffset = null;
    pairingCandidatesLoading = true;
    const requestToken = ++pairingRequestToken;
    actionError = "";
    void cancelPendingCandidatePage().then(() => {
      if (requestToken === pairingRequestToken && pairingInvoice?.invoice?.invoiceId === record.invoice?.invoiceId)
        void loadPairingCandidates(record, requestToken);
    });
  }

  function closePairing(reloadMonthCandidates = true) {
    pairingRequestToken += 1;
    pairingInvoice = null;
    pairingDataVersion = null;
    selectedPaymentId = "";
    pairingFeedback = "";
    validatedSelectedCandidate = null;
    pairingCandidates = null;
    pairingCandidateTotal = 0;
    pairingNextOffset = null;
    pairingCandidatesLoading = false;
    if (busyAction === null) flushRecordRefreshAfterAction();
    if (reloadMonthCandidates && report.summary && activeMonth)
      scheduleCandidatePageLoad(report.knowledgeAt, activeMonth, candidatePageMonthKey);
  }

  async function loadPairingCandidates(record: PurchaseRecord, requestToken: number) {
    const invoiceIdentityId = record.invoice?.invoiceId;
    if (!invoiceIdentityId) return;
    const expectedDataVersion = (pendingReport ?? report).knowledgeAt;
    const selectedAtRequest = selectedPaymentId;
    try {
      const result = await window.octopusBeak.spending.rankPairingCandidates({
        invoiceIdentityId,
        dataVersion: expectedDataVersion,
        selectedTransactionId: selectedAtRequest || undefined,
        limit: initialPairingCandidateCount,
      });
      if (requestToken !== pairingRequestToken || pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId) return;
      if (result.dataVersion !== expectedDataVersion || result.dataVersion !== (pendingReport ?? report).knowledgeAt)
        throw new Error($t.purchaseSpending.pairingDataChanged);
      pairingCandidates = result.candidates;
      pairingCandidateTotal = result.totalCandidateCount;
      pairingNextOffset = result.nextOffset;
      validatedSelectedCandidate = result.selectedCandidate ?? null;
      if (selectedAtRequest && selectedAtRequest === selectedPaymentId && !result.selectedCandidate) {
        selectedPaymentId = "";
        pairingFeedback = $t.purchaseSpending.pairingSelectionUnavailable;
      }
    } catch (error) {
      if (requestToken !== pairingRequestToken) return;
      pairingCandidates = [];
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === pairingRequestToken) pairingCandidatesLoading = false;
    }
  }

  async function showMorePayments() {
    const nextVisibleCount = paymentVisibleCount + 10;
    if (
      pairingInvoice?.invoice &&
      pairingNextOffset !== null &&
      nextVisibleCount > (pairingCandidates?.length ?? 0)
    ) {
      const requestToken = pairingRequestToken;
      const invoiceIdentityId = pairingInvoice.invoice.invoiceId;
      const expectedDataVersion = (pendingReport ?? report).knowledgeAt;
      pairingCandidatesLoading = true;
      try {
        const result = await window.octopusBeak.spending.rankPairingCandidates({
          invoiceIdentityId,
          dataVersion: expectedDataVersion,
          offset: pairingNextOffset,
          limit: 50,
        });
        if (
          requestToken !== pairingRequestToken ||
          pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId
        ) return;
        if (result.dataVersion !== expectedDataVersion || result.dataVersion !== (pendingReport ?? report).knowledgeAt) {
          pairingCandidates = null;
          pairingCandidateTotal = 0;
          pairingNextOffset = null;
          paymentVisibleCount = initialPairingCandidateCount;
          pairingCandidatesLoading = true;
          const restartToken = ++pairingRequestToken;
          void loadPairingCandidates(pairingInvoice, restartToken);
          return;
        }
        pairingCandidates = Object.freeze([...(pairingCandidates ?? []), ...result.candidates]);
        pairingCandidateTotal = result.totalCandidateCount;
        pairingNextOffset = result.nextOffset;
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error);
      } finally {
        if (requestToken === pairingRequestToken) pairingCandidatesLoading = false;
      }
    }
    paymentVisibleCount = Math.min(nextVisibleCount, pairingCandidateTotal);
  }

  async function confirmDirectPair() {
    const invoiceIdentityId = pairingInvoice?.invoice?.invoiceId;
    if (!invoiceIdentityId || !selectedPayment || pairingCandidatesLoading || pendingReport) return;
    cancelPendingRecordRefresh();
    busyAction = `direct:${invoiceIdentityId}/${selectedPaymentId}`;
    actionError = "";
    try {
      if (report.summary) {
        const result = await window.octopusBeak.spending.applyPageAction({
          action: "confirm",
          kind: "direct",
          invoiceIdentityId,
          transactionIdentityId: selectedPaymentId,
          dataVersion: report.knowledgeAt,
        });
        closePairing(false);
        acceptCompactPageAction(result);
        return;
      }
      const paymentRecord = report.records.find((record) => record.basis === "bank-transaction" && record.transaction?.transactionId === selectedPaymentId);
      const pairCandidate = report.candidates.find((candidate) =>
        candidateRecord(candidate.candidateId, "invoice")?.invoice?.invoiceId === invoiceIdentityId &&
        candidateRecord(candidate.candidateId, "transaction")?.transaction?.transactionId === selectedPaymentId);
      const context = pairingInvoice && paymentRecord ? spendingPairingReportContext(report, pairingInvoice, paymentRecord, pairCandidate?.candidateId) : undefined;
      const next = await window.octopusBeak.spending.confirmCandidate({
        kind: "direct",
        invoiceIdentityId,
        transactionIdentityId: selectedPaymentId,
        dataVersion: report.knowledgeAt,
        totalsByCurrency: report.totalsByCurrency,
        pairingReportContext: context,
      });
      report = applySpendingPurchaseReportPatch(report, next.patch);
      closePairing();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      busyAction = null;
    }
  }

  async function revokeLink(record: PurchaseRecord) {
    if (!record.link) return;
    cancelPendingRecordRefresh();
    const action = `revokeLink:${record.link.invoiceId}/${record.link.transactionId}`;
    busyAction = action;
    actionError = "";
    try {
      if (report.summary) {
        const result = await window.octopusBeak.spending.applyPageAction({
          action: "revoke",
          kind: "revoke",
          invoiceIdentityId: record.link.invoiceId,
          transactionIdentityId: record.link.transactionId,
          dataVersion: report.knowledgeAt,
        });
        acceptCompactPageAction(result);
        selectedMonth = activeMonth;
        return;
      }
      const next = await window.octopusBeak.spending.revokeLink({
        invoiceId: record.link.invoiceId,
        transactionId: record.link.transactionId,
      });
      report = applySpendingPurchaseReportPatch(report, next.patch);
      selectedMonth = activeMonth;
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      busyAction = null;
    }
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
  sideSub={(report.summary ? monthCandidateCount !== null && monthCandidateCount > 0 : report.totalStatus === "includes-pending-confirmation")
    ? $t.purchaseSpending.includesPending
    : $t.purchaseSpending.purchaseBasisTotal}
>
  <div class="content spending-dashboard purchase-spending" data-spending-canonical data-purchase-report>
    <section class="card purchase-policy-card" data-policy-id="gross-posted-outflow">
      <div class="policy-copy">
        <h2>{$t.purchaseSpending.basisTitle}</h2>
        <p>{$t.purchaseSpending.basisDescription}</p>
      </div>
      <span class="purchase-total-status" data-total-status={report.summary
        ? monthCandidateCount === null ? "month-pending-unloaded" : monthCandidateCount > 0 ? "includes-pending-confirmation" : "month-clear"
        : report.totalStatus}>
        {report.summary
          ? monthCandidateCount === null
            ? $t.purchaseSpending.preparingCandidates
            : monthCandidateCount > 0
              ? $t.purchaseSpending.pendingCountWarning(monthCandidateCount)
              : $t.purchaseSpending.noPendingMatches
          : report.totalStatus === "includes-pending-confirmation"
            ? $t.purchaseSpending.pendingCountWarning(pendingCandidates.length)
            : $t.purchaseSpending.allSourcesConfirmed}
      </span>
    </section>

    {#if recordPageLoading || pendingReport}
      <p role="status" data-spending-updating>{$t.common.loading}</p>
    {/if}
    {#if actionError || pageError}
      <section class="card purchase-action-error" role="alert">{actionError || pageError}</section>
    {/if}

    <div class="purchase-analysis-grid">
      <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")} let:data>
      {@const summaryBlock = spendingBlockData("summary", data)}
      <section class="card purchase-summary-card">
        <div class="section-heading">
          <div>
            <h2>{$t.purchaseSpending.purchaseTotal}</h2>
            <p>{activeMonth ? monthText(activeMonth) : $t.purchaseSpending.allMonths}</p>
          </div>
          {#if months.length > 0}
            <label class="month-picker">
              <span>{$t.purchaseSpending.month}</span>
              <select value={activeMonth ?? ""} onchange={(event) => chooseMonth(event.currentTarget.value)}>
                {#each [...months].reverse() as month}
                  <option value={month}>{monthText(month)}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
        <div class="summary-amount">
          <strong class="money" data-sensitive>{amountText(selectedMonthTotal)}</strong>
        </div>
        <dl class="summary-facts">
          <div><dt>{$t.purchaseSpending.purchaseCount}</dt><dd>{monthSummary?.recordCount ?? monthRecords.length}</dd></div>
          <div><dt>{$t.purchaseSpending.activeDays}</dt><dd>{spendingDayCount}</dd></div>
          <div><dt>{$t.purchaseSpending.pendingThisMonth}</dt><dd>{monthCandidateCount ?? monthSummary?.pendingCandidateCount ?? "—"}</dd></div>
        </dl>
        {#if availableCurrencies.length > 1}
          <div class="currency-switch" role="group" aria-label={$t.purchaseSpending.chartCurrency}>
            {#each availableCurrencies as currency}
              <button type="button" aria-pressed={currency === selectedCurrency} onclick={() => selectedCurrency = currency}>{currency}</button>
            {/each}
          </div>
        {/if}
        {#if report.summary ? monthCandidateCount !== null && monthCandidateCount > 0 : (summaryBlock?.purchaseReport.totalStatus ?? report.totalStatus) === "includes-pending-confirmation"}
          <p class="pending-total-note" data-pending-total>{$t.purchaseSpending.pendingTotalNote}</p>
        {/if}
      </section>
      </ProgressiveBlock>

      <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")} let:data>
      {@const chartReport = resolveSpendingPurchaseReport(report, spendingBlockData("chart", data))}
      {@const chartCurrencies = currenciesForReport(chartReport)}
      {@const chartCurrency = chartCurrencies.includes(selectedCurrency) ? selectedCurrency : chartCurrencies[0] ?? "TWD"}
      {@const blockChartData = chartDataFor(chartReport, chartMode, activeMonth, chartCurrency)}
      <section class="card purchase-chart-card" aria-label={$t.purchaseSpending.chartAria} data-chart>
        <div class="section-heading chart-heading">
          <div>
            <h2>{chartMode === "day" ? $t.purchaseSpending.dailySpending : $t.purchaseSpending.monthlySpending}</h2>
            <p>{chartCurrency} · {chartMode === "day" && activeMonth ? monthText(activeMonth) : $t.purchaseSpending.recentMonths}</p>
          </div>
          <div class="chart-mode-switch" role="group" aria-label={$t.purchaseSpending.chartRange}>
            <button type="button" aria-pressed={chartMode === "day"} onclick={() => { chartMode = "day"; selectedDay = null; }}>{$t.purchaseSpending.daily}</button>
            <button type="button" aria-pressed={chartMode === "month"} onclick={() => { chartMode = "month"; selectedDay = null; }}>{$t.purchaseSpending.monthly}</button>
          </div>
        </div>
        {#if chartReady}
          <PurchaseActivityBarChart
            data={blockChartData}
            selectedKey={chartMode === "day" ? selectedDay : activeMonth}
            label={chartMode === "day" ? $t.purchaseSpending.dailyAmount : $t.purchaseSpending.monthlyAmount}
            onSelect={selectChartPeriod}
          />
        {:else}
          <div class="purchase-chart-pending" aria-hidden="true"></div>
        {/if}
        <label class="chart-period-picker">
          <span>{chartMode === "day" ? $t.purchaseSpending.chooseDay : $t.purchaseSpending.chooseMonth}</span>
          <select
            aria-label={chartMode === "day" ? $t.purchaseSpending.chooseDayAria : $t.purchaseSpending.chooseMonthAria}
            value={chartMode === "day" ? selectedDay ?? "" : activeMonth ?? ""}
            onchange={(event) => selectChartPeriodFromControl(event.currentTarget.value)}
          >
            {#if chartMode === "day"}<option value="">{$t.purchaseSpending.showFullMonth}</option>{/if}
            {#each blockChartData as datum (datum.key)}
              <option value={datum.key}>{datum.label} · {chartCurrency} {datum.value.toLocaleString($locale)}</option>
            {/each}
          </select>
        </label>
        <p class="chart-hint">{chartMode === "day"
          ? $t.purchaseSpending.dayHint
          : $t.purchaseSpending.monthHint}</p>
      </section>
      </ProgressiveBlock>
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
            <p class="candidate-empty" role={monthCandidateLoading ? "status" : undefined}>{monthCandidateLoading ? $t.purchaseSpending.preparingCandidates : $t.purchaseSpending.noPendingMatches}</p>
          {/if}
          {#each listView.rows as candidate (candidate.candidateId)}
            {@const invoiceRecord = listView.recordsByKey.get(`${candidate.candidateId}:invoice`) ?? null}
            {@const transactionRecord = listView.recordsByKey.get(`${candidate.candidateId}:transaction`) ?? null}
            <article class="candidate-row" data-candidate-id={candidate.candidateId}>
              <div class="candidate-side">
                <strong>{$t.purchaseSpending.invoiceSource}</strong>
                <span>{invoiceRecord?.invoice?.revision.seller.name ?? $t.purchaseSpending.merchantUnavailable}</span>
                <span>{invoiceRecord ? dateText(invoiceRecord.occurrence.value) : "--"} · {invoiceRecord ? amountText(invoiceRecord.amount) : "--"}</span>
              </div>
              <div class="candidate-compare"><span class="possible-duplicate">{$t.purchaseSpending.possibleMatch}</span><span>{$t.purchaseSpending.review}</span></div>
              <div class="candidate-side">
                <strong>{transactionRecord ? basisLabel(transactionRecord) : $t.purchaseSpending.bankSource}</strong>
                <span>{transactionRecord?.transaction?.description ?? $t.purchaseSpending.descriptionUnavailable}</span>
                <span>{transactionRecord ? dateText(transactionRecord.occurrence.value) : "--"} · {transactionRecord ? amountText(transactionRecord.amount) : "--"}</span>
              </div>
              <div class="candidate-actions">
                <button type="button" class="button primary" disabled={busyAction !== null || pendingReport !== null} data-confirm-candidate onclick={() => void confirmCandidate(candidate.candidateId)}>{$t.purchaseSpending.confirmMatch}</button>
                <button type="button" class="button secondary" disabled={busyAction !== null || pendingReport !== null} data-deny-candidate onclick={() => void denyCandidate(candidate.candidateId)}>{$t.purchaseSpending.denyCandidate}</button>
              </div>
            </article>
          {/each}
          {#if report.summary ? monthCandidateCount !== null && monthCandidateCount > candidateVisibleCount : listView.visible.length > candidateVisibleCount}
            <button type="button" class="button secondary show-more-candidates" data-show-more-candidates onclick={() => report.summary ? void showMoreCandidates() : candidateVisibleCount = Math.min(candidateVisibleCount + 10, listView.visible.length)}>{$t.purchaseSpending.showMore}</button>
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
        {#if selectedDay}<button type="button" class="button secondary" onclick={() => selectedDay = null}>{$t.purchaseSpending.showFullMonth}</button>{/if}
      </div>
      <div class="purchase-record-list">
        {#each detailsRecordGroups as group (group.date)}
          <section class="purchase-day-group" data-purchase-day={group.date}>
            <header class="purchase-day-heading">
              <div><strong>{dateText(group.date)}</strong><span>{$t.purchaseSpending.dayPurchasesCount(group.records.length)}</span></div>
              <div class="day-totals">{#each group.totals as total (total.currency)}<span class="money" data-sensitive>{amountText(total)}</span>{/each}</div>
            </header>
            {#each group.records as record (record.purchaseId)}
          <article class:possible={record.possibleDuplicate} class="purchase-record" data-purchase-record data-basis={record.basis} data-transaction-id={record.transaction?.transactionId ?? ""} data-possible-duplicate={record.possibleDuplicate}>
            <div class="purchase-record-main">
              <div class="purchase-record-heading"><strong>{recordLabel(record)}</strong><span class="purchase-basis">{basisLabel(record)}</span>{#if record.possibleDuplicate}<span class="possible-duplicate">{$t.purchaseSpending.possibleDuplicate}</span>{/if}</div>
              {#if occurrenceBasisLabel(record)}<span class="fallback-date" data-date-basis="posting-date-fallback">{occurrenceBasisLabel(record)}</span>{/if}
              {#if record.basis === "linked" && record.transaction}
                <span>{$t.purchaseSpending.paymentAmount}: {amountText(record.transaction.amount)} · {record.transaction.amount.currency}</span>
                <span>{$t.purchaseSpending.invoicePurchaseDate}: {dateText(record.occurrence.value)} · {$t.purchaseSpending.consumeDate}: {record.transaction.consumeDate ? dateText(record.transaction.consumeDate) : $t.purchaseSpending.notProvided} · {$t.purchaseSpending.postingDate}: {record.transaction.postingDate ? dateText(record.transaction.postingDate) : dateText(record.transaction.effectiveOn)}</span>
                {#if transactionDateBasisLabel(record.transaction)}<span class="fallback-date" data-transaction-date-basis="posting-date-fallback">{transactionDateBasisLabel(record.transaction)}</span>{/if}
                {#if record.difference}<span data-link-difference>{$t.purchaseSpending.invoiceAmount}: {amountText(record.difference.invoiceAmount)} · {$t.purchaseSpending.bankAmount}: {amountText(record.difference.bankAmount)} · {$t.purchaseSpending.difference}: {record.difference.exactAmountEqual ? "0" : $t.purchaseSpending.amountDifferenceNotInferred}</span>{/if}
              {/if}
              {#if record.items.length > 0}
                <details class="item-list" data-item-details>
                  <summary>{$t.purchaseSpending.invoiceItemsCount(record.items.length)}</summary>
                  {#each record.items as item (item.itemId)}
                    <span>{item.name ?? $t.purchaseSpending.itemNameUnavailable} · {$t.purchaseSpending.quantity}: {exactText(item.quantity)} · {$t.purchaseSpending.category}: {itemCategory(item)} · {$t.purchaseSpending.itemAmount}: {amountText(item.amount)}</span>
                  {/each}
                </details>
              {/if}
              {#if record.basis === "invoice" && record.invoice}
                <button type="button" class="button secondary pair-button" disabled={busyAction !== null || pendingReport !== null} data-open-pairing onclick={() => openPairing(record)}>{$t.purchaseSpending.matchPayment}</button>
              {/if}
              {#if record.link}
                <details class="source-details" data-source-details><summary>{$t.purchaseSpending.sourceAndMatchEvidence}</summary><div>{$t.purchaseSpending.matchEvent}: {record.link.eventId} · {$t.purchaseSpending.knowledge}: {record.link.evidenceKnowledgeSequence} · {$t.purchaseSpending.origin}: {record.link.origin}</div><pre>{JSON.stringify(record.link.evidence)}</pre></details>
                <button type="button" class="button secondary revoke-button" disabled={busyAction !== null || pendingReport !== null} data-revoke-link onclick={() => void revokeLink(record)}>{$t.purchaseSpending.revokeMatch}</button>
              {/if}
              {#if record.refund}<span class="refund-note">{$t.purchaseSpending.refundPeriod} · {record.refund.provenanceReference}</span>{/if}
            </div>
            <div class="purchase-record-side"><strong class="money" data-sensitive>{amountText(record.amount, record.basis === "refund")}</strong></div>
          </article>
            {/each}
          </section>
        {:else}<div class="purchase-empty"><strong>{$t.purchaseSpending.noPurchases}</strong><span>{$t.purchaseSpending.chooseOtherPeriod}</span></div>{/each}
      </div>
      {#if recordPageNextCursor}
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
            <button type="button" class="button secondary" onclick={() => closePairing()}>{$t.common.close}</button>
          </div>
          <p class="panel-meta">{$t.purchaseSpending.pairingHelp}</p>
          {#if pairingFeedback}<p class="panel-meta pairing-feedback" role="status">{pairingFeedback}</p>{/if}
          <div class="pairing-invoice-summary">
            <strong>{recordLabel(pairingInvoice)}</strong>
            <span>{dateText(pairingInvoice.occurrence.value)} · {amountText(pairingInvoice.amount)}</span>
          </div>
          <fieldset class="payment-options" data-total-candidate-count={pairingCandidateTotal} data-loaded-candidate-count={pairingCandidates?.length ?? 0}>
            <legend>{$t.purchaseSpending.eligiblePayments}</legend>
            {#if pairingCandidatesLoading}
              <span class="panel-meta pairing-loading" role="status"><span class="pairing-spinner" aria-hidden="true"></span>{$t.purchaseSpending.preparingCandidates}</span>
            {:else}
              {#each visibleEligiblePayments as payment (payment.purchaseId)}
                <label class="payment-option">
                  <input type="radio" name="spending-payment" value={payment.transactionId} bind:group={selectedPaymentId} onchange={() => pairingFeedback = ""} />
                  <span><strong>{pairingBasisLabel(payment)}</strong><span>{pairingRecordLabel(payment)}</span><small>{dateText(payment.occurrence.value)} · {amountText(payment.amount)} · {payment.amount.currency}</small></span>
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
              <span>{$t.purchaseSpending.amountCurrencyFromBank}: {amountText(selectedPayment.amount)}</span>
              <span>{$t.purchaseSpending.dateFromInvoice}: {dateText(pairingInvoice.occurrence.value)}</span>
              {#if pairingInvoice.amount?.currency !== selectedPayment.amount?.currency || exactText(pairingInvoice.amount) !== exactText(selectedPayment.amount)}
                <span>{$t.purchaseSpending.sourceDifferenceNotInferred}</span>
              {/if}
            </div>
          {/if}
          {#if busyAction !== null}
            <span class="panel-meta pairing-loading" role="status" data-pairing-feedback="confirm-busy"><span class="pairing-spinner" aria-hidden="true"></span>{$t.purchaseSpending.savingPair}</span>
          {/if}
          <button type="button" class="button primary" disabled={!selectedPayment || pairingCandidatesLoading || busyAction !== null || Boolean(pendingReport)} data-confirm-direct-pair onclick={() => void confirmDirectPair()}>{$t.purchaseSpending.confirmMatch}</button>
        </div>
      </section>
    {/if}

    {#if fallbackCanonical.availability === "unavailable"}
      <p class="panel-meta purchase-canonical-note">{$t.purchaseSpending.missingCanonical}</p>
    {/if}
  </div>
</DashboardShell>

<style>
  .purchase-spending { display: grid; gap: var(--space-5); }
  .purchase-spending :global(button) { transition: background 160ms ease, border-color 160ms ease, color 160ms ease; }
  .purchase-policy-card, .purchase-summary-card, .purchase-chart-card, .purchase-candidates-card, .purchase-records-card, .purchase-action-error { min-width: 0; }
  .purchase-policy-card { display: flex; align-items: center; justify-content: space-between; gap: var(--space-6); padding: var(--space-4) var(--space-5); background: var(--accent-soft); border-color: color-mix(in oklch, var(--accent) 22%, var(--border)); }
  .policy-copy { display: flex; align-items: baseline; gap: var(--space-4); min-width: 0; }
  .policy-copy h2 { flex: 0 0 auto; margin: 0; font-size: 14px; }
  .policy-copy p { max-width: 75ch; margin: 0; color: color-mix(in oklch, var(--accent) 45%, var(--fg)); font-size: 13px; }
  .purchase-total-status { flex: 0 0 auto; color: var(--success); font-size: 12px; font-weight: 720; white-space: nowrap; }
  .purchase-total-status[data-total-status="includes-pending-confirmation"], .possible-duplicate, .purchase-action-error { color: var(--danger); }
  .purchase-action-error { padding: var(--space-4) var(--space-5); background: color-mix(in oklch, var(--danger) 8%, white); }

  .purchase-analysis-grid { display: grid; grid-template-columns: minmax(290px, 0.7fr) minmax(0, 1.55fr); gap: var(--space-5); align-items: stretch; }
  .purchase-summary-card, .purchase-chart-card, .purchase-candidates-card, .purchase-records-card { padding: var(--space-5); }
  .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
  .section-heading h2 { margin: 0; font-size: 18px; line-height: 1.25; letter-spacing: -0.015em; }
  .section-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
  .month-picker { display: grid; gap: 4px; color: var(--muted); font-size: 11px; }
  .month-picker select { min-height: 36px; padding: 0 34px 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); }
  .summary-amount { margin: var(--space-8) 0 var(--space-6); }
  .summary-amount strong { font-size: 30px; line-height: 1; letter-spacing: -0.03em; }
  .summary-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; border-block: 1px solid var(--border); }
  .summary-facts div { min-width: 0; padding: var(--space-3) var(--space-2); }
  .summary-facts div + div { border-left: 1px solid var(--border); }
  .summary-facts dt { color: var(--muted); font-size: 11px; }
  .summary-facts dd { margin: 4px 0 0; font-size: 20px; font-weight: 740; }
  .currency-switch, .chart-mode-switch { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius); background: var(--surface-soft); }
  .currency-switch { margin-top: var(--space-4); }
  .currency-switch button, .chart-mode-switch button { min-height: 30px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font-size: 12px; }
  .currency-switch button[aria-pressed="true"], .chart-mode-switch button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: 0 2px 8px rgb(15 23 42 / 0.08); }
  .pending-total-note, .purchase-canonical-note { margin: var(--space-4) 0 0; color: var(--muted); font-size: 12px; }
  .chart-heading { margin-bottom: var(--space-3); }
  .purchase-chart-pending { min-height: 280px; }
  .chart-period-picker { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); color: var(--muted); font-size: 11px; }
  .chart-period-picker select { min-height: 32px; max-width: 210px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; }
  .chart-hint { margin: var(--space-2) 0 0; color: var(--muted); font-size: 11px; text-align: center; }

  .purchase-candidates-card { display: grid; gap: var(--space-4); }
  .candidate-scope { display: flex; align-items: center; gap: var(--space-3); color: var(--muted); font-size: 12px; }
  .candidate-list { display: grid; }
  .candidate-empty { margin: 0; padding: var(--space-5); border-radius: var(--radius); background: var(--surface-soft); color: var(--muted); text-align: center; }
  .candidate-row { display: grid; grid-template-columns: minmax(0, 1fr) 116px minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-top: 1px solid var(--border); }
  .candidate-side { display: grid; gap: 3px; min-width: 0; }
  .candidate-side strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .candidate-side span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .item-list summary, .source-details summary { cursor: pointer; color: var(--accent); }
  .item-list span { display: block; margin-top: 4px; }
  .source-details pre { max-width: 100%; margin: 5px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .revoke-button, .pair-button { justify-self: start; margin-top: 4px; }
  .refund-note { color: var(--success) !important; }
  .purchase-empty { display: grid; gap: 5px; padding: var(--space-8) var(--space-5); color: var(--muted); text-align: center; }
  .purchase-empty strong { color: var(--fg); }

  .pairing-dialog-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: var(--space-5); background: rgb(0 0 0 / 45%); }
  .pairing-dialog { width: min(680px, 100%); max-height: 85vh; overflow: auto; padding: var(--space-5); }
  .pairing-invoice-summary, .pairing-effect { display: grid; gap: 4px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
  .pairing-invoice-summary span, .pairing-effect span { color: var(--muted); font-size: 12px; }
  .payment-options { display: grid; gap: var(--space-2); margin: var(--space-4) 0; padding: 0; border: 0; }
  .payment-options legend { margin-bottom: var(--space-2); font-weight: 700; }
  .payment-option { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
  .payment-option:hover { border-color: color-mix(in oklch, var(--accent) 35%, var(--border)); background: var(--accent-soft); }
  .payment-option span { display: grid; gap: 3px; }
  .payment-option small { color: var(--muted); }
  .pairing-effect { margin-bottom: var(--space-4); }
  .pairing-loading { display: inline-flex; align-items: center; gap: 7px; }
  .pairing-spinner { width: 12px; height: 12px; border: 2px solid color-mix(in oklch, var(--accent) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: pairing-spin 700ms linear infinite; }
  @keyframes pairing-spin { to { transform: rotate(360deg); } }

  @media (max-width: 1050px) {
    .purchase-analysis-grid { grid-template-columns: 1fr; }
    .candidate-row { grid-template-columns: minmax(0, 1fr) 96px minmax(0, 1fr); }
    .candidate-actions { grid-column: 1 / -1; justify-content: start; }
  }
  @media (max-width: 680px) {
    .purchase-policy-card, .policy-copy, .section-heading { align-items: flex-start; flex-direction: column; }
    .purchase-total-status { white-space: normal; }
    .candidate-scope { width: 100%; justify-content: space-between; }
    .candidate-row { grid-template-columns: 1fr; }
    .candidate-compare { justify-items: start; text-align: left; }
    .candidate-compare::before { display: none; }
    .candidate-compare span { padding-left: 0; }
    .purchase-record { grid-template-columns: 1fr; gap: var(--space-2); }
    .purchase-record-side { text-align: left; }
    .purchase-day-heading { align-items: flex-start; }
    .purchase-day-heading, .purchase-day-heading > div { flex-direction: column; gap: 3px; }
    .summary-facts { grid-template-columns: 1fr; }
    .summary-facts div + div { border-left: 0; border-top: 1px solid var(--border); }
    .chart-period-picker { align-items: stretch; flex-direction: column; }
    .chart-period-picker select { max-width: none; width: 100%; }
  }
</style>
