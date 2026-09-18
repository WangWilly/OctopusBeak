<script lang="ts">
  import { tick } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { financialPerformanceTelemetry } from "$lib/performance/financial-performance-telemetry.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { exactToNumber } from "$lib/shared-money/exact.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    rankSpendingManualPaymentCandidates,
    type SpendingPurchaseRecordView as PurchaseRecord,
    type SpendingPurchaseReportView as PurchaseReport,
  } from "../purchase-matching.ts";
  import type { SpendingPageDto, SpendingPurchaseActionResult } from "../model.ts";
  import {
    applyValidatedSpendingActionResult,
    beginSpendingPendingCommand,
    completeSpendingPendingCommand,
    isSpendingActionUncertain,
    spendingActionErrorCode,
    type SpendingPendingCommand,
    type SpendingPendingCommandIdentity,
  } from "../spending-action-lifecycle.ts";
  import { stableFinancialErrorCode } from "$lib/shared-ledger/financial-error.ts";
  import PurchaseActivityBarChart, {
    type PurchaseActivityDatum,
  } from "./PurchaseActivityBarChart.svelte";

  export let purchaseReport: PurchaseReport;
  export let fallbackCanonical: SpendingPageDto["canonical"];
  export let onActionReconciliation: (() => Promise<void>) | undefined = undefined;

  let report = purchaseReport;
  let previousReport: PurchaseReport | undefined;
  let selectedMonth: string | null = null;
  let busyAction: string | null = null;
  let actionError = "";
  let actionNotice = "";
  let actionReconciliationPending = false;
  let pairingInvoice: PurchaseRecord | null = null;
  let selectedPaymentId = "";
  let paymentVisibleCount = 10;
  let candidateVisibleCount = 10;
  let previousCandidateKey = "";
  let chartMode: "day" | "month" = "day";
  let selectedCurrency = "";
  let selectedDay: string | null = null;
  let showAllCandidates = false;

  $: if (previousReport !== purchaseReport) {
    previousReport = purchaseReport;
    report = purchaseReport;
    selectedMonth = null;
    actionError = "";
  }
  $: months = [...new Set(report.records.map((record) => record.occurrence.value.slice(0, 7)))].sort();
  $: activeMonth = selectedMonth ?? months.at(-1) ?? null;
  $: monthRecords = report.records.filter((record) => activeMonth === null || record.occurrence.value.startsWith(`${activeMonth}-`));
  $: visibleRecords = monthRecords
    .filter((record) => selectedDay === null || record.occurrence.value.startsWith(selectedDay))
    .slice()
    .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
  $: availableCurrencies = [...new Set(report.records.flatMap((record) => record.amount ? [record.amount.currency] : []))].sort();
  $: if (!selectedCurrency || !availableCurrencies.includes(selectedCurrency)) selectedCurrency = availableCurrencies[0] ?? "TWD";
  $: pendingCandidates = report.candidates.filter((candidate) => candidate.status === "candidate");
  $: monthCandidates = pendingCandidates.filter((candidate) => {
    const invoice = candidateRecordsByKey.get(`${candidate.candidateId}:invoice`);
    const transaction = candidateRecordsByKey.get(`${candidate.candidateId}:transaction`);
    return activeMonth === null || invoice?.occurrence.value.startsWith(`${activeMonth}-`) || transaction?.occurrence.value.startsWith(`${activeMonth}-`);
  });
  $: visibleCandidates = showAllCandidates ? pendingCandidates : monthCandidates;
  $: candidateKey = visibleCandidates.map((candidate) => `${candidate.candidateId}:${candidate.status}`).join("\u0001");
  $: if (candidateKey !== previousCandidateKey) {
    previousCandidateKey = candidateKey;
    candidateVisibleCount = Math.min(10, visibleCandidates.length);
  }
  $: visibleCandidateRows = visibleCandidates.slice(0, candidateVisibleCount);
  $: allEligiblePayments = report.records.filter((record) => record.basis === "bank-transaction" && record.transaction !== null);
  $: eligiblePayments = (() => {
    if (!pairingInvoice?.invoice) return allEligiblePayments;
    const paymentById = new Map(allEligiblePayments.map((record) => [record.transaction!.transactionId, record]));
    return rankSpendingManualPaymentCandidates(pairingInvoice.invoice, allEligiblePayments.map((record) => record.transaction!))
      .map((candidate) => paymentById.get(candidate.transactionId))
      .filter((record): record is PurchaseRecord => record !== undefined);
  })();
  $: visibleEligiblePayments = eligiblePayments.slice(0, paymentVisibleCount);
  $: selectedPayment = eligiblePayments.find((record) => record.transaction?.transactionId === selectedPaymentId) ?? null;
  $: monthTotals = totalsByMonth(report.records);
  $: visibleTotals = totalsByCurrency(monthRecords);
  $: selectedMonthTotal = visibleTotals.find((amount) => amount.currency === selectedCurrency) ?? null;
  $: spendingDayCount = new Set(monthRecords.map((record) => record.occurrence.value.slice(0, 10))).size;
  $: recordGroups = groupRecordsByDate(visibleRecords);
  $: chartData = chartMode === "day"
    ? dailyChartData(monthRecords, activeMonth, selectedCurrency)
    : monthlyChartData(monthTotals, selectedCurrency);
  $: candidateRecordsByKey = (() => {
    const index = new Map<string, PurchaseRecord>();
    for (const record of report.records) {
      for (const candidateId of record.candidateIds) {
        if (record.invoice) index.set(`${candidateId}:invoice`, record);
        if (record.transaction) index.set(`${candidateId}:transaction`, record);
      }
    }
    return index;
  })();

  function moneyValue(amount: { coefficient: string; scale: number; currency: string }) {
    return {
      currency: amount.currency,
      value: exactToNumber(amount),
      exact: { coefficient: amount.coefficient, scale: amount.scale },
    };
  }

  function amountText(amount: { coefficient: string; scale: number; currency: string } | null, signed = false) {
    if (!amount) return $locale === "zh-TW" ? "金額未提供" : "Amount unavailable";
    return formatMoney(moneyValue(amount), { locale: $locale, signed });
  }

  function exactText(value: { coefficient: string; scale: number } | null) {
    if (!value) return $locale === "zh-TW" ? "無資料" : "Unavailable";
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
    return record.description ?? record.invoice?.revision.seller.name ?? record.transaction?.description ?? ($locale === "zh-TW" ? "未提供商家名稱" : "Merchant unavailable");
  }

  function basisLabel(record: PurchaseRecord) {
    if (record.basis === "linked") return $locale === "zh-TW" ? "已配對購買" : "Linked purchase";
    if (record.basis === "invoice") return $locale === "zh-TW" ? "電子發票購買" : "E-Invoice purchase";
    if (record.basis === "refund") return $locale === "zh-TW" ? "退款" : "Refund";
    const isCreditCard = record.transaction?.stream === "credit-card";
    return isCreditCard
      ? ($locale === "zh-TW" ? "信用卡消費" : "Credit-card purchase")
      : ($locale === "zh-TW" ? "銀行交易" : "Bank transaction");
  }

  function occurrenceBasisLabel(record: PurchaseRecord) {
    return record.occurrence.basis === "posting-date-fallback"
      ? ($locale === "zh-TW" ? "以入帳日期代替" : "Posting date used as fallback")
      : null;
  }

  function transactionDateBasisLabel(transaction: NonNullable<PurchaseRecord["transaction"]>) {
    return transaction.effectiveDateBasis === "posting-date-fallback"
      ? ($locale === "zh-TW" ? "消費日期未提供，以入帳日期代替" : "Consume date unavailable; posting date used")
      : null;
  }

  function candidateRecord(candidateId: string, kind: "invoice" | "transaction") {
    return candidateRecordsByKey.get(`${candidateId}:${kind}`) ?? null;
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
    showAllCandidates = false;
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
    const invoice = candidateRecord(candidateId, "invoice")?.invoice;
    const transaction = candidateRecord(candidateId, "transaction")?.transaction;
    if (!invoice || !transaction) {
      busyAction = `confirmCandidate:${candidateId}`;
      actionError = "";
      await reconcileSpendingAction();
      busyAction = null;
      return;
    }
    await runSpendingAction(
      `confirmCandidate:${candidateId}`,
      (idempotencyKey) => {
        if (!idempotencyKey) throw new Error("Spending command idempotency key is required.");
        return window.octopusBeak.spending.confirmCandidate({
          kind: "candidate",
          invoiceIdentityId: invoice.invoiceId,
          transactionIdentityId: transaction.transactionId,
          idempotencyKey,
        });
      },
      {
        action: "candidate-confirmation",
        firstId: invoice.invoiceId,
        secondId: transaction.transactionId,
      },
    );
  }

  async function denyCandidate(candidateId: string) {
    await decideCandidate(candidateId, "denyCandidate");
  }

  async function decideCandidate(candidateId: string, action: "confirmCandidate" | "denyCandidate") {
    if (action === "confirmCandidate") {
      await confirmCandidate(candidateId);
      return;
    }
    await runSpendingAction(
      `${action}:${candidateId}`,
      () => window.octopusBeak.spending.denyCandidate({ kind: "candidate", candidateId }),
    );
  }

  function openPairing(record: PurchaseRecord) {
    pairingInvoice = record;
    selectedPaymentId = "";
    paymentVisibleCount = 10;
    actionError = "";
  }

  function closePairing() {
    pairingInvoice = null;
    selectedPaymentId = "";
  }

  async function confirmDirectPair() {
    const invoiceIdentityId = pairingInvoice?.invoice?.invoiceId;
    if (!invoiceIdentityId || !selectedPaymentId) return;
    await runSpendingAction(
      `direct:${invoiceIdentityId}/${selectedPaymentId}`,
      (idempotencyKey) => window.octopusBeak.spending.confirmCandidate({
        kind: "direct",
        invoiceIdentityId,
        transactionIdentityId: selectedPaymentId,
        idempotencyKey,
      }),
      {
        action: "direct-pair",
        firstId: invoiceIdentityId,
        secondId: selectedPaymentId,
      },
      closePairing,
    );
  }

  async function revokeLink(record: PurchaseRecord) {
    const link = record.link;
    if (!link) return;
    const action = `revokeLink:${link.invoiceId}/${link.transactionId}`;
    await runSpendingAction(
      action,
      (idempotencyKey) => window.octopusBeak.spending.revokeLink({
        invoiceId: link.invoiceId,
        transactionId: link.transactionId,
        idempotencyKey,
      }),
      {
        action: "unlink",
        firstId: link.invoiceId,
        secondId: link.transactionId,
      },
    );
  }

  function actionErrorText(error: unknown): string {
    const code = stableFinancialErrorCode(error);
    if (code === "spending-pair-stale") {
      return $t.financialErrors.spendingPairStale;
    }
    if (code === "idempotency-key-conflict") {
      return $t.financialErrors.idempotencyConflict;
    }
    if (code === "idempotency-storage-unavailable") {
      return $t.financialErrors.idempotencyStorageUnavailable;
    }
    if (code === "canonical-cutoff-unavailable") return $t.financialErrors.cutoffUnavailable;
    if (code === "contention") return $t.financialErrors.contention;
    if (code === "cancelled") return $t.financialErrors.cancelled;
    if (code === "worker-closed") return $t.financialErrors.workerClosed;
    if (code === "worker-exit") return $t.financialErrors.workerExit;
    if (code === "worker-error") return $t.financialErrors.workerError;
    return $t.financialErrors.generic;
  }

  async function reconcileSpendingAction(
    command?: SpendingPendingCommand,
    options: { dataChanged?: boolean } = {},
  ): Promise<boolean> {
    actionReconciliationPending = true;
    actionError = "";
    try {
      if (!onActionReconciliation) throw new Error("spending-action-reconciliation-unavailable");
      await onActionReconciliation();
      if (command) completeSpendingPendingCommand(command);
      if (options.dataChanged) {
        actionNotice = $locale === "zh-TW"
          ? "資料已更新，已重新載入最新配對狀態。"
          : "The data changed; the latest pairing state has been loaded.";
      }
      return true;
    } catch (error) {
      actionError = $locale === "zh-TW"
        ? "無法確認配對結果，請重新整理資料。"
        : "The pairing result could not be confirmed. Please refresh the data.";
      console.warn("spending-action-reconciliation-failed", stableFinancialErrorCode(error));
      return false;
    } finally {
      actionReconciliationPending = false;
    }
  }

  async function applySpendingActionResult(
    result: SpendingPurchaseActionResult,
    command?: SpendingPendingCommand,
    telemetry?: ReturnType<typeof financialPerformanceTelemetry.startOperation>,
  ): Promise<boolean> {
    try {
      report = applyValidatedSpendingActionResult(report, result);
      telemetry?.startSpan("patch-applied", {
        knowledgePointDistance: 0,
      }).finish();
      selectedMonth = activeMonth;
      actionNotice = "";
      if (command) completeSpendingPendingCommand(command);
      return true;
    } catch (error) {
      telemetry?.startSpan("patch-applied").finish("error", { error });
      await reconcileSpendingAction(command, {
        dataChanged: spendingActionErrorCode(error) === "spending-pair-stale" ||
          (error instanceof Error && error.message === "spending-action-stale"),
      });
      return false;
    }
  }

  async function runSpendingAction(
    action: string,
    request: (idempotencyKey: string | undefined) => Promise<SpendingPurchaseActionResult>,
    identity?: SpendingPendingCommandIdentity,
    onSuccess?: () => void,
  ): Promise<void> {
    busyAction = action;
    actionError = "";
    const telemetry = financialPerformanceTelemetry.startOperation("spending-action");
    telemetry.startSpan("action-start").finish();
    let telemetryFinished = false;
    let command: SpendingPendingCommand | undefined;
    try {
      command = identity ? beginSpendingPendingCommand(identity) : undefined;
      const result = await request(command?.idempotencyKey);
      if (await applySpendingActionResult(result, command, telemetry)) {
        await tick();
        telemetry.finish("paint-ready");
        telemetryFinished = true;
        onSuccess?.();
      }
    } catch (error) {
      const code = spendingActionErrorCode(error);
      if (code === "idempotency-key-conflict") {
        if (command) completeSpendingPendingCommand(command);
        actionError = actionErrorText(error);
      } else if (code === "spending-pair-stale" || isSpendingActionUncertain(error)) {
        await reconcileSpendingAction(command, { dataChanged: code === "spending-pair-stale" });
      } else {
        actionError = actionErrorText(error);
      }
    } finally {
      if (!telemetryFinished) {
        telemetry.finish("action-result", "error", { error: actionError || undefined });
      }
      busyAction = null;
    }
  }

  function itemCategory(item: PurchaseRecord["items"][number]) {
    const category = item.sourceFacts.category;
    return typeof category === "string" && category.trim()
      ? category
      : ($locale === "zh-TW" ? "未分類" : "Unclassified");
  }
</script>

<DashboardShell
  active="spending"
  eyebrow={$locale === "zh-TW" ? "消費" : "Spending"}
  title={$locale === "zh-TW" ? "個人消費" : "Personal spending"}
  sideLabel={$locale === "zh-TW" ? "購買行為合計" : "Purchases total"}
  sideValue={report.totalsByCurrency.length > 0 ? report.totalsByCurrency.map((amount) => amountText(amount)).join(" / ") : "--"}
  sideSub={report.totalStatus === "includes-pending-confirmation"
    ? ($locale === "zh-TW" ? "含待確認項目" : "Includes pending confirmation")
    : ($locale === "zh-TW" ? "依購買日期認列" : "Purchase-basis total")}
>
  <div class="content spending-dashboard purchase-spending" data-spending-canonical data-purchase-report>
    <section class="card purchase-policy-card" data-policy-id="gross-posted-outflow">
      <div class="policy-copy">
        <h2>{$locale === "zh-TW" ? "消費基準" : "Spending basis"}</h2>
        <p>
          {$locale === "zh-TW"
            ? "依購買發生日歸類。未配對的發票與付款會先各自列入；確認為同一筆後，只保留付款金額。"
            : "Purchases are grouped by purchase date. Unmatched invoices and payments count separately until a match is confirmed, then only the payment amount remains."}
        </p>
      </div>
      <span class="purchase-total-status" data-total-status={report.totalStatus}>
        {report.totalStatus === "includes-pending-confirmation"
          ? ($locale === "zh-TW" ? `${pendingCandidates.length} 筆待確認，總額可能重複` : `${pendingCandidates.length} pending; total may include duplicates`)
          : ($locale === "zh-TW" ? "所有來源已確認" : "All sources confirmed")}
      </span>
    </section>

    {#if actionReconciliationPending}
      <section class="card purchase-action-pending" role="status" aria-live="polite">{$locale === "zh-TW" ? "讀取中…" : "Checking the latest pairing result…"}</section>
    {/if}

    {#if actionNotice}
      <section class="card purchase-action-status" data-action-notice role="status" aria-live="polite">
        <span>{actionNotice}</span>
        <button type="button" class="button secondary" onclick={() => actionNotice = ""}>{$locale === "zh-TW" ? "知道了" : "Dismiss"}</button>
      </section>
    {/if}

    {#if actionError}
      <section class="card purchase-action-error" role="alert">{actionError}</section>
    {/if}

    <div class="purchase-analysis-grid">
      <section class="card purchase-summary-card">
        <div class="section-heading">
          <div>
            <h2>{$locale === "zh-TW" ? "購買總額" : "Purchase total"}</h2>
            <p>{activeMonth ? monthText(activeMonth) : ($locale === "zh-TW" ? "全部月份" : "All months")}</p>
          </div>
          {#if months.length > 0}
            <label class="month-picker">
              <span>{$locale === "zh-TW" ? "月份" : "Month"}</span>
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
          <div><dt>{$locale === "zh-TW" ? "消費筆數" : "Purchases"}</dt><dd>{monthRecords.length}</dd></div>
          <div><dt>{$locale === "zh-TW" ? "有消費的日子" : "Active days"}</dt><dd>{spendingDayCount}</dd></div>
          <div><dt>{$locale === "zh-TW" ? "本月待確認" : "Pending this month"}</dt><dd>{monthCandidates.length}</dd></div>
        </dl>
        {#if availableCurrencies.length > 1}
          <div class="currency-switch" role="group" aria-label={$locale === "zh-TW" ? "圖表幣別" : "Chart currency"}>
            {#each availableCurrencies as currency}
              <button type="button" aria-pressed={currency === selectedCurrency} onclick={() => selectedCurrency = currency}>{currency}</button>
            {/each}
          </div>
        {/if}
        {#if report.totalStatus === "includes-pending-confirmation"}
          <p class="pending-total-note" data-pending-total>{$locale === "zh-TW" ? "待確認的發票與付款目前分開計入。完成配對後，總額會自動去重。" : "Pending invoices and payments currently count separately. The total is deduplicated after confirmation."}</p>
        {/if}
      </section>

      <section class="card purchase-chart-card" aria-label={$locale === "zh-TW" ? "消費圖表" : "Spending chart"} data-chart>
        <div class="section-heading chart-heading">
          <div>
            <h2>{chartMode === "day" ? ($locale === "zh-TW" ? "每日消費" : "Daily spending") : ($locale === "zh-TW" ? "每月消費" : "Monthly spending")}</h2>
            <p>{selectedCurrency} · {chartMode === "day" && activeMonth ? monthText(activeMonth) : ($locale === "zh-TW" ? "最近月份" : "Recent months")}</p>
          </div>
          <div class="chart-mode-switch" role="group" aria-label={$locale === "zh-TW" ? "圖表範圍" : "Chart range"}>
            <button type="button" aria-pressed={chartMode === "day"} onclick={() => { chartMode = "day"; selectedDay = null; }}>{$locale === "zh-TW" ? "每日" : "Daily"}</button>
            <button type="button" aria-pressed={chartMode === "month"} onclick={() => { chartMode = "month"; selectedDay = null; }}>{$locale === "zh-TW" ? "每月" : "Monthly"}</button>
          </div>
        </div>
        <PurchaseActivityBarChart
          data={chartData}
          selectedKey={chartMode === "day" ? selectedDay : activeMonth}
          label={chartMode === "day" ? ($locale === "zh-TW" ? "每日消費金額" : "Daily spending amount") : ($locale === "zh-TW" ? "每月消費金額" : "Monthly spending amount")}
          onSelect={selectChartPeriod}
        />
        <label class="chart-period-picker">
          <span>{chartMode === "day" ? ($locale === "zh-TW" ? "選擇日期" : "Choose a day") : ($locale === "zh-TW" ? "選擇月份" : "Choose a month")}</span>
          <select
            aria-label={chartMode === "day" ? ($locale === "zh-TW" ? "選擇日期以篩選購買明細" : "Choose a day to filter purchases") : ($locale === "zh-TW" ? "選擇月份以查看每日消費" : "Choose a month to view daily spending")}
            value={chartMode === "day" ? selectedDay ?? "" : activeMonth ?? ""}
            onchange={(event) => selectChartPeriodFromControl(event.currentTarget.value)}
          >
            {#if chartMode === "day"}<option value="">{$locale === "zh-TW" ? "顯示整月" : "Show full month"}</option>{/if}
            {#each chartData as datum (datum.key)}
              <option value={datum.key}>{datum.label} · {selectedCurrency} {datum.value.toLocaleString($locale)}</option>
            {/each}
          </select>
        </label>
        <p class="chart-hint">{chartMode === "day"
          ? ($locale === "zh-TW" ? "點選日期可只看當天明細；再次點選即可取消。" : "Select a day to filter the list below; select it again to clear.")
          : ($locale === "zh-TW" ? "點選月份可切換到該月的每日消費。" : "Select a month to open its daily view.")}</p>
      </section>
    </div>

    {#if pendingCandidates.length > 0}
      <section class="card purchase-candidates-card" data-candidates>
        <div class="section-heading">
          <div><h2>{$locale === "zh-TW" ? "待確認配對" : "Pending matches"}</h2><p>{$locale === "zh-TW" ? "確認同一筆消費，避免發票與付款重複計入。" : "Confirm matching purchases to avoid counting an invoice and payment twice."}</p></div>
          <div class="candidate-scope">
            <span>{visibleCandidates.length} {$locale === "zh-TW" ? "筆" : "items"}</span>
            {#if pendingCandidates.length !== monthCandidates.length}
              <button type="button" class="button secondary" onclick={() => { showAllCandidates = !showAllCandidates; candidateVisibleCount = 10; }}>{showAllCandidates ? ($locale === "zh-TW" ? "只看本月" : "This month") : ($locale === "zh-TW" ? `查看全部 ${pendingCandidates.length} 筆` : `View all ${pendingCandidates.length}`)}</button>
            {/if}
          </div>
        </div>
        <div class="candidate-list">
          {#if visibleCandidates.length === 0}
            <p class="candidate-empty">{$locale === "zh-TW" ? "這個月沒有待確認配對。你可以查看其他月份的候選。" : "There are no pending matches this month. You can review candidates from other months."}</p>
          {/if}
          {#each visibleCandidateRows as candidate (candidate.candidateId)}
            {@const invoiceRecord = candidateRecord(candidate.candidateId, "invoice")}
            {@const transactionRecord = candidateRecord(candidate.candidateId, "transaction")}
            <article class="candidate-row" data-candidate-id={candidate.candidateId}>
              <div class="candidate-side">
                <strong>{$locale === "zh-TW" ? "發票來源" : "Invoice source"}</strong>
                <span>{invoiceRecord?.invoice?.revision.seller.name ?? ($locale === "zh-TW" ? "未知商家" : "Merchant unavailable")}</span>
                <span>{invoiceRecord ? dateText(invoiceRecord.occurrence.value) : "--"} · {invoiceRecord ? amountText(invoiceRecord.amount) : "--"}</span>
              </div>
              <div class="candidate-compare"><span class="possible-duplicate">{$locale === "zh-TW" ? "可能是同一筆" : "Possible match"}</span><span>{$locale === "zh-TW" ? "待確認" : "Review"}</span></div>
              <div class="candidate-side">
                <strong>{transactionRecord ? basisLabel(transactionRecord) : ($locale === "zh-TW" ? "銀行來源" : "Bank source")}</strong>
                <span>{transactionRecord?.transaction?.description ?? ($locale === "zh-TW" ? "未提供交易描述" : "Description unavailable")}</span>
                <span>{transactionRecord ? dateText(transactionRecord.occurrence.value) : "--"} · {transactionRecord ? amountText(transactionRecord.amount) : "--"}</span>
              </div>
              <div class="candidate-actions">
                <button type="button" class="button primary" disabled={busyAction !== null} data-confirm-candidate onclick={() => void confirmCandidate(candidate.candidateId)}>{$locale === "zh-TW" ? "確認配對" : "Confirm match"}</button>
                <button type="button" class="button secondary" disabled={busyAction !== null} data-deny-candidate onclick={() => void denyCandidate(candidate.candidateId)}>{$locale === "zh-TW" ? "否認候選" : "Deny candidate"}</button>
              </div>
            </article>
          {/each}
          {#if visibleCandidates.length > candidateVisibleCount}
            <button type="button" class="button secondary show-more-candidates" data-show-more-candidates onclick={() => candidateVisibleCount = Math.min(candidateVisibleCount + 10, visibleCandidates.length)}>{$locale === "zh-TW" ? "顯示更多" : "Show more"}</button>
          {/if}
        </div>
      </section>
    {/if}

    <section class="card purchase-records-card">
      <div class="section-heading records-heading">
        <div><h2>{$locale === "zh-TW" ? "購買明細" : "Purchases"}</h2><p>{selectedDay ? dateText(selectedDay) : activeMonth ? monthText(activeMonth) : ($locale === "zh-TW" ? "全部紀錄" : "All records")} · {visibleRecords.length} {$locale === "zh-TW" ? "筆" : "records"}</p></div>
        {#if selectedDay}<button type="button" class="button secondary" onclick={() => selectedDay = null}>{$locale === "zh-TW" ? "顯示整月" : "Show full month"}</button>{/if}
      </div>
      <div class="purchase-record-list">
        {#each recordGroups as group (group.date)}
          <section class="purchase-day-group" data-purchase-day={group.date}>
            <header class="purchase-day-heading">
              <div><strong>{dateText(group.date)}</strong><span>{group.records.length} {$locale === "zh-TW" ? "筆消費" : "purchases"}</span></div>
              <div class="day-totals">{#each group.totals as total (total.currency)}<span class="money" data-sensitive>{amountText(total)}</span>{/each}</div>
            </header>
            {#each group.records as record (record.purchaseId)}
          <article class:possible={record.possibleDuplicate} class="purchase-record" data-purchase-record data-basis={record.basis} data-possible-duplicate={record.possibleDuplicate}>
            <div class="purchase-record-main">
              <div class="purchase-record-heading"><strong>{recordLabel(record)}</strong><span class="purchase-basis">{basisLabel(record)}</span>{#if record.possibleDuplicate}<span class="possible-duplicate">{$locale === "zh-TW" ? "可能重複" : "Possible duplicate"}</span>{/if}</div>
              {#if occurrenceBasisLabel(record)}<span class="fallback-date" data-date-basis="posting-date-fallback">{occurrenceBasisLabel(record)}</span>{/if}
              {#if record.basis === "linked" && record.transaction}
                <span>{$locale === "zh-TW" ? "付款金額" : "Payment amount"}: {amountText(record.transaction.amount)} · {record.transaction.amount.currency}</span>
                <span>{$locale === "zh-TW" ? "發票購買日" : "Invoice purchase date"}: {dateText(record.occurrence.value)} · {$locale === "zh-TW" ? "消費日期" : "Consume date"}: {record.transaction.consumeDate ? dateText(record.transaction.consumeDate) : ($locale === "zh-TW" ? "未提供" : "Unavailable")} · {$locale === "zh-TW" ? "入帳日" : "Posting date"}: {record.transaction.postingDate ? dateText(record.transaction.postingDate) : dateText(record.transaction.effectiveOn)}</span>
                {#if transactionDateBasisLabel(record.transaction)}<span class="fallback-date" data-transaction-date-basis="posting-date-fallback">{transactionDateBasisLabel(record.transaction)}</span>{/if}
                {#if record.difference}<span data-link-difference>{$locale === "zh-TW" ? "發票金額" : "Invoice amount"}: {amountText(record.difference.invoiceAmount)} · {$locale === "zh-TW" ? "銀行金額" : "Bank amount"}: {amountText(record.difference.bankAmount)} · {$locale === "zh-TW" ? "差額" : "Difference"}: {record.difference.exactAmountEqual ? "0" : $locale === "zh-TW" ? "來源金額不同，未推算費用" : "Source amounts differ; no fee inferred"}</span>{/if}
              {/if}
              {#if record.items.length > 0}
                <details class="item-list" data-item-details>
                  <summary>{record.items.length} {$locale === "zh-TW" ? "個發票品項" : "invoice items"}</summary>
                  {#each record.items as item (item.itemId)}
                    <span>{item.name ?? ($locale === "zh-TW" ? "未提供品項名稱" : "Item name unavailable")} · {$locale === "zh-TW" ? "數量" : "Qty"}: {exactText(item.quantity)} · {$locale === "zh-TW" ? "分類" : "Category"}: {itemCategory(item)} · {$locale === "zh-TW" ? "品項金額" : "Item amount"}: {amountText(item.amount)}</span>
                  {/each}
                </details>
              {/if}
              {#if record.basis === "invoice" && record.invoice}
                <button type="button" class="button secondary pair-button" disabled={busyAction !== null} data-open-pairing onclick={() => openPairing(record)}>{$locale === "zh-TW" ? "配對付款" : "Match payment"}</button>
              {/if}
              {#if record.link}
                <details class="source-details" data-source-details><summary>{$locale === "zh-TW" ? "來源與配對證據" : "Source and match evidence"}</summary><div>{$locale === "zh-TW" ? "配對事件" : "Match event"}: {record.link.eventId} · {$locale === "zh-TW" ? "知識點" : "Knowledge"}: {record.link.evidenceKnowledgeSequence} · {$locale === "zh-TW" ? "來源" : "Origin"}: {record.link.origin}</div><pre>{JSON.stringify(record.link.evidence)}</pre></details>
                <button type="button" class="button secondary revoke-button" disabled={busyAction !== null} data-revoke-link onclick={() => void revokeLink(record)}>{$locale === "zh-TW" ? "撤銷配對" : "Revoke match"}</button>
              {/if}
              {#if record.refund}<span class="refund-note">{$locale === "zh-TW" ? "退款依退款發生月份認列" : "Refund recognized in its occurrence month"} · {record.refund.provenanceReference}</span>{/if}
            </div>
            <div class="purchase-record-side"><strong class="money" data-sensitive>{amountText(record.amount, record.basis === "refund")}</strong></div>
          </article>
            {/each}
          </section>
        {:else}<div class="purchase-empty"><strong>{$locale === "zh-TW" ? "這個期間沒有消費" : "No purchases in this period"}</strong><span>{$locale === "zh-TW" ? "選擇其他日期或月份查看明細。" : "Choose another day or month to view purchases."}</span></div>{/each}
      </div>
    </section>

    {#if pairingInvoice?.invoice}
      <section class="pairing-dialog-backdrop" data-pairing-dialog>
        <div class="card pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
          <div class="panel-title">
            <div><p class="eyebrow">{$locale === "zh-TW" ? "人工配對" : "Manual match"}</p><h2 id="pairing-title">{$locale === "zh-TW" ? "選擇付款交易" : "Choose a payment transaction"}</h2></div>
            <button type="button" class="button secondary" onclick={closePairing}>{$locale === "zh-TW" ? "關閉" : "Close"}</button>
          </div>
          <p class="panel-meta">{$locale === "zh-TW" ? "你可以選擇不同月份、金額或幣別的付款。系統不會自動配對，也不會把相似度當成證據。" : "You may choose a payment with a different month, amount, or currency. The app never auto-matches or treats similarity as evidence."}</p>
          <div class="pairing-invoice-summary">
            <strong>{recordLabel(pairingInvoice)}</strong>
            <span>{dateText(pairingInvoice.occurrence.value)} · {amountText(pairingInvoice.amount)}</span>
          </div>
          <fieldset class="payment-options">
            <legend>{$locale === "zh-TW" ? "可配對的付款交易" : "Eligible payment transactions"}</legend>
            {#each visibleEligiblePayments as payment (payment.purchaseId)}
              <label class="payment-option">
                <input type="radio" name="spending-payment" value={payment.transaction!.transactionId} bind:group={selectedPaymentId} />
                <span><strong>{basisLabel(payment)}</strong><span>{recordLabel(payment)}</span><small>{dateText(payment.occurrence.value)} · {amountText(payment.amount)} · {payment.amount?.currency}</small></span>
              </label>
            {:else}
              <span class="panel-meta">{$locale === "zh-TW" ? "沒有可配對的付款交易" : "No eligible payment transactions"}</span>
            {/each}
            {#if eligiblePayments.length > paymentVisibleCount}
              <button type="button" class="button secondary show-more-payments" data-show-more-payments onclick={() => paymentVisibleCount += 10}>{$locale === "zh-TW" ? "顯示更多" : "Show more"}</button>
            {/if}
          </fieldset>
          {#if selectedPayment?.transaction}
            <div class="pairing-effect" data-direct-pair-effect>
              <strong>{$locale === "zh-TW" ? "配對後的認列方式" : "Recognition after matching"}</strong>
              <span>{$locale === "zh-TW" ? "金額與幣別採銀行付款" : "Amount and currency use the bank payment"}: {amountText(selectedPayment.amount)}</span>
              <span>{$locale === "zh-TW" ? "日期採發票購買日" : "Date uses the invoice purchase date"}: {dateText(pairingInvoice.occurrence.value)}</span>
              {#if pairingInvoice.amount?.currency !== selectedPayment.amount?.currency || exactText(pairingInvoice.amount) !== exactText(selectedPayment.amount)}
                <span>{$locale === "zh-TW" ? "來源金額或幣別不同；不推算差額用途。" : "Source amount or currency differs; no use for the difference is inferred."}</span>
              {/if}
            </div>
          {/if}
          <button type="button" class="button primary" disabled={!selectedPaymentId || busyAction !== null} data-confirm-direct-pair onclick={() => void confirmDirectPair()}>{$locale === "zh-TW" ? "確認配對" : "Confirm match"}</button>
        </div>
      </section>
    {/if}

    {#if fallbackCanonical.availability === "unavailable"}
      <p class="panel-meta purchase-canonical-note">{$locale === "zh-TW" ? "部分銀行交易仍缺少消費認列必要資料。" : "Some bank transactions still lack the facts required for spending recognition."}</p>
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
