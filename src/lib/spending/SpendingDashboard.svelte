<script lang="ts">
  import { onMount, tick } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    SPENDING_CATEGORY_IDS,
    isSpendingCategory,
    type SpendingCategory,
  } from "./categories.ts";
  import DailySpendingModal from "./components/DailySpendingModal.svelte";
  import InvoiceDetailModal from "./components/InvoiceDetailModal.svelte";
  import SpendingBarChart from "./components/SpendingBarChart.svelte";
  import { applySpendingAccountOverride } from "./model.ts";
  import type {
    SpendingAccountRecord,
    SpendingDateGroup,
    SpendingPageDto,
    SpendingState,
  } from "./model.ts";

  export let spending: SpendingPageDto;

  let selectedMonth: string | undefined;
  let selectedCategory: SpendingCategory | undefined;
  let monthTabs: HTMLDivElement | null = null;
  let categoryFilters: HTMLDivElement | null = null;
  let allCategoryFilter: HTMLButtonElement | null = null;
  let recordList: HTMLDivElement | null = null;
  let dailyModalOpen = false;
  let selectedInvoiceKey: string | undefined;
  let dailyModalTrigger: HTMLButtonElement | null = null;
  let invoiceModalTrigger: HTMLButtonElement | null = null;
  let savingItemKeys = new Set<string>();
  let errorItemKeys = new Set<string>();
  let savingRecordIds = new Set<string>();
  let errorRecordIds = new Set<string>();
  let pendingCategories: Partial<Record<string, SpendingCategory>> = {};
  let showExcludedRecords = false;
  let loadRequestSequence = 0;

  $: model = spending;
  $: monthFormatter = new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" });
  $: recordDateFormatter = new Intl.DateTimeFormat($locale, {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  });
  $: activeMonthLabel = model.selectedMonth ? formatMonth(model.selectedMonth) : "";
  $: sideValue = model.selectedMonth
    ? formatMoney(
        { currency: "TWD", value: model.selectedMonthSummary.total },
        { locale: $locale },
      )
    : "--";
  $: confirmedCount = model.selectedMonthSummary.invoiceCount + model.selectedMonthSummary.accountCount;
  $: sideSub = model.selectedMonth
    ? $t.spending.sideSub(activeMonthLabel, confirmedCount)
    : $t.spending.noSpendingTitle;
  $: datasetStatus = model.months.length > 0
      ? $t.spending.datasetStatus(
        model.selectedMonthSummary.invoiceCount,
        model.selectedMonthSummary.accountCount,
        formatMonth(model.months[0]),
        formatMonth(model.months.at(-1) ?? model.months[0]),
      )
    : $t.spending.noSpendingTitle;
  $: activeCategory = selectedCategory ?? model.selectedCategory;
  $: transactionSaving = savingRecordIds.size > 0;
  $: visibleRecordGroups = buildVisibleRecordGroups(model, activeCategory, showExcludedRecords);
  $: visibleRecordCount = visibleRecordGroups.reduce((count, group) => count + group.records.length, 0);
  $: selectedInvoice = selectedInvoiceKey
    ? spending.invoices.find((invoice) => invoice.invoiceKey === selectedInvoiceKey) ?? null
    : null;

  onMount(() => {
    void tick().then(scrollSelectedMonthIntoView);
  });

  async function selectMonth(month: string) {
    if (savingRecordIds.size > 0) return;
    const requestSequence = ++loadRequestSequence;
    const previousSpending = spending;
    const previousCategory = selectedCategory;
    selectedMonth = month;
    selectedCategory = undefined;
    try {
      const loaded = await window.octopusBeak.spending.load({ selectedMonth: month });
      if (requestSequence !== loadRequestSequence) return;
      spending = loaded;
      selectedMonth = undefined;
    } catch {
      if (requestSequence !== loadRequestSequence) return;
      spending = previousSpending;
      selectedMonth = undefined;
      selectedCategory = previousCategory;
    }
    await tick();
    scrollSelectedMonthIntoView();
  }

  async function selectCategory(category: SpendingCategory | undefined) {
    if (savingRecordIds.size > 0) return;
    const requestSequence = ++loadRequestSequence;
    const previousSpending = spending;
    const previousCategory = selectedCategory;
    selectedCategory = category;
    try {
      const loaded = await window.octopusBeak.spending.load({
        selectedMonth: selectedMonth ?? model.selectedMonth ?? undefined,
        selectedCategory: category,
      });
      if (requestSequence !== loadRequestSequence) return;
      spending = loaded;
      selectedMonth = undefined;
    } catch {
      if (requestSequence !== loadRequestSequence) return;
      spending = previousSpending;
      selectedCategory = previousCategory;
    }
  }

  async function reloadSelectedSpending(snapshot: SpendingPageDto) {
    const requestSequence = ++loadRequestSequence;
    try {
      const loaded = await window.octopusBeak.spending.load({
        selectedMonth: selectedMonth ?? model.selectedMonth ?? undefined,
        selectedCategory: activeCategory,
      });
      if (requestSequence === loadRequestSequence) spending = loaded;
    } catch (error) {
      if (requestSequence === loadRequestSequence) spending = snapshot;
      throw error;
    }
  }

  async function updateTransactionState(
    record: SpendingAccountRecord,
    state: SpendingState | null,
    category: SpendingCategory | null = record.category,
  ) {
    if (savingRecordIds.size > 0) return;
    ++loadRequestSequence;
    const snapshot = spending;
    savingRecordIds = new Set(savingRecordIds).add(record.statementRowId);
    errorRecordIds = new Set(errorRecordIds);
    errorRecordIds.delete(record.statementRowId);
    spending = applySpendingAccountOverride(spending, record.statementRowId, state, category);
    try {
      await window.octopusBeak.spending.updateTransactionOverride(state === null
        ? { statementRowId: record.statementRowId, state: null }
        : {
            statementRowId: record.statementRowId,
            state,
            category,
            automaticState: record.automaticState,
            automaticReason: record.automaticReason,
          });
      await reloadSelectedSpending(snapshot);
    } catch {
      spending = snapshot;
      errorRecordIds = new Set(errorRecordIds).add(record.statementRowId);
    } finally {
      savingRecordIds = new Set(savingRecordIds);
      savingRecordIds.delete(record.statementRowId);
    }
  }

  function openDailyModal(event: MouseEvent) {
    dailyModalTrigger = event.currentTarget as HTMLButtonElement;
    dailyModalOpen = true;
  }

  async function closeDailyModal() {
    const trigger = dailyModalTrigger;
    dailyModalOpen = false;
    dailyModalTrigger = null;
    await tick();
    trigger?.focus();
  }

  function openInvoiceModal(event: MouseEvent, invoiceKey: string) {
    invoiceModalTrigger = event.currentTarget as HTMLButtonElement;
    selectedInvoiceKey = invoiceKey;
  }

  async function closeInvoiceModal() {
    const trigger = invoiceModalTrigger;
    selectedInvoiceKey = undefined;
    invoiceModalTrigger = null;
    await tick();
    if (trigger?.isConnected) {
      trigger.focus();
      return;
    }
    const fallback = recordList?.querySelector<HTMLButtonElement>(".invoice-row")
      ?? categoryFilters?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?? allCategoryFilter;
    fallback?.focus();
  }

  async function updateItemCategory(itemKey: string, category: string) {
    if (!isSpendingCategory(category) || savingItemKeys.has(itemKey)) return;
    const item = spending.invoices.flatMap((invoice) => invoice.items)
      .find((candidate) => candidate.itemKey === itemKey);
    if (!item || item.category === category) return;

    const previousCategory = item.category;
    savingItemKeys = new Set(savingItemKeys).add(itemKey);
    errorItemKeys = new Set(errorItemKeys);
    errorItemKeys.delete(itemKey);
    replaceItemCategory(itemKey, category);

    try {
      await window.octopusBeak.spending.updateItemCategory({ itemKey, category });
      await tick();
      if (selectedCategory && model.invoices.length === 0) {
        selectedCategory = undefined;
      }
    } catch {
      replaceItemCategory(itemKey, previousCategory);
      errorItemKeys = new Set(errorItemKeys).add(itemKey);
    } finally {
      savingItemKeys = new Set(savingItemKeys);
      savingItemKeys.delete(itemKey);
    }
  }

  function replaceItemCategory(itemKey: string, category: SpendingCategory) {
    spending = {
      ...spending,
      invoices: spending.invoices.map((invoice) => invoice.items.some((item) => item.itemKey === itemKey)
        ? {
            ...invoice,
            items: invoice.items.map((item) => item.itemKey === itemKey ? { ...item, category } : item),
          }
        : invoice),
    };
  }

  function scrollSelectedMonthIntoView() {
    monthTabs
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function formatMonth(month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    return year && monthNumber
      ? monthFormatter.format(new Date(Date.UTC(year, monthNumber - 1, 1)))
      : month;
  }

  function formatRecordDate(date: string) {
    return recordDateFormatter.format(new Date(`${date}T00:00:00Z`));
  }

  function pendingCategory(record: SpendingAccountRecord) {
    return pendingCategories[record.statementRowId] ?? record.category;
  }

  function setPendingCategory(record: SpendingAccountRecord, value: string) {
    if (!isSpendingCategory(value)) return;
    pendingCategories = { ...pendingCategories, [record.statementRowId]: value };
  }

  function buildVisibleRecordGroups(
    source: SpendingPageDto,
    category: SpendingCategory | undefined,
    includeExcluded: boolean,
  ): SpendingDateGroup[] {
    const displayedKeys = new Set(source.recordsByDate.flatMap((group) => group.records)
      .map((record) => record.key));
    const missingExcluded = Map.groupBy(source.excludedAccountRecords.filter((record) =>
      !displayedKeys.has(record.key) && (!category || record.category === category)
    ), (record) => record.date);
    return source.recordsByDate.map((group) => {
      const extra = missingExcluded.get(group.date) ?? [];
      return {
        ...group,
        records: [
          ...group.records.filter((record) => includeExcluded || record.state !== "excluded"),
          ...(includeExcluded ? extra : []),
        ],
        excludedCount: group.excludedCount + extra.length,
      };
    });
  }

</script>

<DashboardShell
  active="spending"
  eyebrow={$t.spending.eyebrow}
  title={$t.spending.title}
  sideLabel={$t.spending.sideLabel}
  {sideValue}
  {sideSub}
>
  <div class="content spending-dashboard">
    {#if model.months.length === 0}
      <section class="card spending-empty">
        <h2>{$t.spending.noSpendingTitle}</h2>
        <p>{$t.spending.noSpendingBody}</p>
      </section>
    {:else}
      <section class="card monthly-panel" aria-label={$t.spending.monthlyChartAria}>
        <div class="panel-title spending-panel-title">
          <div class="panel-heading">
            <p class="eyebrow">{$t.spending.monthlyEyebrow}</p>
            <h2>{$t.spending.monthlyTitle}</h2>
            <p class="panel-meta" role="status">{datasetStatus}</p>
          </div>
        </div>
        <div class="spending-chart-pad">
          <SpendingBarChart
            rows={model.monthlyRows}
            kind="month"
            selectedKey={selectedMonth ?? model.selectedMonth}
            label={$t.spending.monthlyChartAria}
            onBarClick={(month) => void selectMonth(month)}
          />
        </div>
        <div class="chart-note">
          <span>{$t.spending.monthlyHint}</span>
          <span>{$t.spending.categoryHint}</span>
        </div>
      </section>

      <div class="month-toolbar">
        <div class="month-tabs" bind:this={monthTabs} role="group" aria-label={$t.spending.monthSelectorAria}>
          {#each model.months as month}
            <button
              class="filter-btn month-button"
              type="button"
              disabled={transactionSaving}
              aria-pressed={month === (selectedMonth ?? model.selectedMonth)}
              onclick={() => void selectMonth(month)}
            >
              {formatMonth(month)}
            </button>
          {/each}
        </div>
        <button
          class="button daily-chart-button"
          type="button"
          title={$t.spending.openDailyChart}
          aria-label={$t.spending.openDailyChart}
          onclick={openDailyModal}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19V10M10 19V5M16 19v-7M22 19H2"></path>
          </svg>
        </button>
      </div>

      <section class="card invoice-panel">
        <div class="panel-title invoice-header">
          <div class="invoice-summary">
            <p class="eyebrow">{$t.spending.dailyEyebrow}</p>
            <h2>{$t.spending.dailyTitle(activeMonthLabel)}</h2>
            <div class="invoice-summary-value">
              <strong class="money" data-sensitive>
                {formatMoney(
                  { currency: "TWD", value: model.selectedMonthSummary.total },
                  { locale: $locale },
                )}
              </strong>
              <span>{$t.spending.confirmedCount(confirmedCount)}</span>
            </div>
          </div>
          <div class="invoice-heading">
            <p class="eyebrow">{$t.spending.recordsEyebrow}</p>
            <h2>{$t.spending.dailyRecords}</h2>
            <p class="panel-meta" role="status" aria-live="polite">
              {$t.spending.resultCount(visibleRecordCount)} · {$t.spending.newestFirst}
            </p>
          </div>
        </div>

        <div class="invoice-tools">
          <div
            class="category-filters"
            bind:this={categoryFilters}
            role="group"
            aria-label={$t.spending.categoryFilterAria}
          >
            <button
              bind:this={allCategoryFilter}
              class="filter-btn"
              type="button"
              disabled={transactionSaving}
              aria-pressed={!activeCategory}
              onclick={() => void selectCategory(undefined)}
            >
              {$t.spending.allCategories}
            </button>
            {#each model.presentCategories as category}
              <button
                class="filter-btn"
                type="button"
                disabled={transactionSaving}
                aria-pressed={activeCategory === category}
                onclick={() => void selectCategory(category)}
              >
                {$t.spending.categories[category]}
              </button>
            {/each}
          </div>
          {#if model.excludedAccountRecords.length > 0}
            <div class="excluded-disclosure">
              <span>{$t.spending.excludedDisclosure(model.excludedAccountRecords.length)}</span>
              <button
                type="button"
                aria-expanded={showExcludedRecords}
                onclick={() => showExcludedRecords = !showExcludedRecords}
              >
                {showExcludedRecords ? $t.spending.hideExcluded : $t.spending.reviewExcluded}
              </button>
            </div>
          {/if}
        </div>

        <div class="record-list" bind:this={recordList}>
          {#if visibleRecordGroups.length > 0}
            {#each visibleRecordGroups as group (group.date)}
              <section class="record-day">
                <header class="date-head">
                  <strong>{formatRecordDate(group.date)}</strong>
                  <span>{$t.spending.daySummary(
                    formatMoney({ currency: "TWD", value: group.includedTotal }, { locale: $locale }),
                    group.excludedCount,
                    group.pendingCount,
                  )}</span>
                </header>
                <div class="record-rows">
                  {#each group.records as record (record.key)}
                    {#if record.source === "invoice"}
                      <button
                        class="record-row invoice-row"
                        type="button"
                        aria-label={$t.spending.invoiceRowAria(
                          record.label,
                          record.label,
                          formatMoney({ currency: "TWD", value: record.amount }, { locale: $locale }),
                        )}
                        onclick={(event) => openInvoiceModal(event, record.invoiceKey)}
                      >
                        <div class="record-main">
                          <strong class="merchant-name">{record.label}</strong>
                          <div class="record-meta">
                            <span>{$t.spending.invoiceSource}</span>
                            {#each record.categories as category}
                              <span class="category-chip category-{category}">
                                {$t.spending.categories[category]}
                              </span>
                            {/each}
                          </div>
                        </div>
                        <strong class="record-amount money" data-sensitive>
                          {formatMoney({ currency: "TWD", value: record.amount }, { locale: $locale })}
                        </strong>
                        <span class="status-chip included">{$t.spending.invoiceStatus}</span>
                      </button>
                    {:else}
                      <div class="record-row account-row">
                        <div class="record-main">
                          <strong class="merchant-name">{record.label}</strong>
                          <div class="record-meta">
                            <span>{$t.spending.accountSource}</span>
                            <span>· {record.manual
                              ? $t.spending.manualReason
                              : $t.spending.reasons[record.automaticReason]}</span>
                            <span class="category-chip category-{record.category}">
                              {$t.spending.categories[record.category]}
                            </span>
                          </div>
                          {#if errorRecordIds.has(record.statementRowId)}
                            <span class="record-error" role="alert">{$t.spending.overrideError}</span>
                          {/if}
                        </div>
                        <strong class="record-amount money" data-sensitive>
                          {formatMoney({ currency: "TWD", value: record.amount }, { locale: $locale })}
                        </strong>
                        <div class="record-actions">
                          <span class="status-chip {record.state}">{$t.spending.states[record.state]}</span>
                          {#if record.state === "pending" && !record.manual}
                            <select
                              aria-label={$t.spending.pendingCategory}
                              value={pendingCategory(record)}
                              disabled={transactionSaving}
                              onchange={(event) => setPendingCategory(record, event.currentTarget.value)}
                            >
                              {#each SPENDING_CATEGORY_IDS as category}
                                <option value={category}>{$t.spending.categories[category]}</option>
                              {/each}
                            </select>
                            <div class="pending-buttons">
                              <button
                                type="button"
                                disabled={transactionSaving}
                                onclick={() => void updateTransactionState(record, "included", pendingCategory(record))}
                              >{$t.spending.includeExpense}</button>
                              <button
                                type="button"
                                disabled={transactionSaving}
                                onclick={() => void updateTransactionState(record, "excluded")}
                              >{$t.spending.excludeExpense}</button>
                            </div>
                          {:else if record.manual}
                            <button
                              type="button"
                              disabled={transactionSaving}
                              onclick={() => void updateTransactionState(record, null)}
                            >{$t.spending.restoreAutomatic}</button>
                          {:else if record.state === "excluded"}
                            <button
                              type="button"
                              disabled={transactionSaving}
                              onclick={() => void updateTransactionState(record, "included")}
                            >{$t.spending.restoreExpense}</button>
                          {:else if record.state === "included"}
                            <button
                              type="button"
                              disabled={transactionSaving}
                              onclick={() => void updateTransactionState(record, "excluded")}
                            >{$t.spending.excludeExpense}</button>
                          {/if}
                          {#if savingRecordIds.has(record.statementRowId)}
                            <span class="saving-label" role="status">{$t.spending.savingOverride}</span>
                          {/if}
                        </div>
                      </div>
                    {/if}
                  {/each}
                </div>
              </section>
            {/each}
          {:else}
            <div class="invoice-empty">
              <strong>{$t.spending.noRecordsTitle}</strong>
              <span>{$t.spending.noRecordsBody}</span>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    {#if dailyModalOpen && model.selectedMonth}
      <DailySpendingModal
        month={activeMonthLabel}
        total={model.selectedMonthSummary.total}
        invoiceCount={model.selectedMonthSummary.invoiceCount}
        accountCount={model.selectedMonthSummary.accountCount}
        rows={model.dailyRows}
        onClose={closeDailyModal}
      />
    {/if}

    {#if selectedInvoice}
      <InvoiceDetailModal
        invoice={selectedInvoice}
        {savingItemKeys}
        {errorItemKeys}
        onClose={closeInvoiceModal}
        onCategoryChange={updateItemCategory}
      />
    {/if}
  </div>
</DashboardShell>

<style>
  .spending-dashboard {
    --spending-food: oklch(52% 0.11 250);
    --spending-daily: oklch(52% 0.09 170);
    --spending-transport: oklch(56% 0.10 70);
    --spending-shopping: oklch(53% 0.08 320);
    --spending-home: oklch(50% 0.07 35);
    --spending-leisure: oklch(49% 0.06 215);
    --spending-other: oklch(46% 0.035 250);

    display: grid;
    gap: var(--space-6);
  }

  .monthly-panel,
  .invoice-panel {
    min-width: 0;
    overflow: hidden;
  }

  .spending-panel-title {
    justify-content: flex-start;
  }

  .panel-heading,
  .invoice-summary,
  .invoice-heading {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .panel-meta {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .spending-chart-pad {
    min-width: 0;
    padding: 12px var(--space-5) var(--space-4);
    overflow: hidden;
  }

  .chart-note {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 0 var(--space-5) var(--space-4);
    color: var(--muted);
    font-size: 12px;
  }

  .month-toolbar,
  .month-tabs {
    min-width: 0;
  }

  .month-toolbar {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
  }

  .month-tabs {
    flex: 1 1 auto;
  }

  .month-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .month-tabs::-webkit-scrollbar,
  .category-filters::-webkit-scrollbar {
    display: none;
  }

  .month-button {
    min-height: 40px;
    flex: 0 0 auto;
    padding: 0 14px;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
    white-space: nowrap;
  }

  .month-button[aria-pressed="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 1px 3px rgb(15 23 42 / 0.06);
  }

  .daily-chart-button {
    width: 48px;
    min-width: 48px;
    min-height: 48px;
    padding: 0;
  }

  .daily-chart-button svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .invoice-header {
    align-items: end;
  }

  .invoice-summary-value {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin-top: 5px;
  }

  .invoice-summary-value strong {
    font-size: 17px;
    line-height: 1;
  }

  .invoice-summary-value span {
    color: var(--muted);
    font-size: 12px;
  }

  .invoice-heading {
    justify-items: end;
    text-align: right;
  }

  .invoice-tools {
    border-bottom: 1px solid var(--border);
  }

  .category-filters {
    min-width: 0;
    display: flex;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .category-filters .filter-btn {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .excluded-disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 10px var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
  }

  .excluded-disclosure button,
  .record-actions button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .record-list {
    max-height: 620px;
    display: grid;
    align-content: start;
    overflow-y: auto;
  }

  .record-day {
    min-width: 0;
  }

  .date-head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 9px var(--space-5);
    border-block: 1px solid var(--border);
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
  }

  .date-head strong {
    color: var(--fg);
  }

  .record-rows {
    padding-inline: var(--space-5);
    background: var(--surface);
  }

  .record-row {
    width: 100%;
    min-width: 0;
    min-height: 76px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(104px, auto);
    align-items: center;
    gap: var(--space-4);
    padding: 12px 0;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
  }

  .invoice-row {
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .invoice-row:hover {
    background: var(--surface-soft);
  }

  .invoice-row:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .record-row:last-child {
    border-bottom: 0;
  }

  .record-main {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .record-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  .record-amount {
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .record-actions {
    min-width: 104px;
    display: grid;
    justify-items: end;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
  }

  .record-actions select {
    max-width: 150px;
    min-height: 30px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }

  .pending-buttons {
    display: flex;
    gap: var(--space-2);
  }

  .status-chip {
    display: inline-flex;
    width: fit-content;
    padding: 3px 7px;
    border-radius: 999px;
    font-size: 10px;
    white-space: nowrap;
  }

  .status-chip.included { color: oklch(42% 0.08 165); background: oklch(94% 0.025 165); }
  .status-chip.excluded { color: var(--muted); background: var(--surface-soft); }
  .status-chip.pending { color: oklch(42% 0.10 70); background: oklch(93% 0.08 80); }

  .record-error {
    color: var(--danger, oklch(50% 0.17 25));
    font-size: 11px;
  }

  .category-chip {
    --swatch: var(--spending-other);

    width: fit-content;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.4;
    white-space: nowrap;
  }

  .category-chip::before {
    width: 7px;
    height: 7px;
    display: block;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--swatch);
    content: "";
  }

  .category-food { --swatch: var(--spending-food); }
  .category-daily { --swatch: var(--spending-daily); }
  .category-transport { --swatch: var(--spending-transport); }
  .category-shopping { --swatch: var(--spending-shopping); }
  .category-home { --swatch: var(--spending-home); }
  .category-leisure { --swatch: var(--spending-leisure); }
  .category-other { --swatch: var(--spending-other); }

  .merchant-name {
    margin: 0;
  }

  .merchant-name {
    overflow: hidden;
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .invoice-empty,
  .spending-empty {
    display: grid;
    place-items: center;
    gap: 4px;
    padding: 48px var(--space-6);
    text-align: center;
  }

  .invoice-empty {
    color: var(--muted);
  }

  .invoice-empty strong,
  .spending-empty h2 {
    margin: 0;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: 18px;
  }

  .spending-empty p {
    margin: 0;
    color: var(--muted);
  }

  @media (max-width: 760px) {
    .spending-chart-pad {
      padding-inline: var(--space-2);
    }

    .chart-note,
    .invoice-header {
      align-items: start;
      flex-direction: column;
    }

    .chart-note {
      display: flex;
    }

    .invoice-heading {
      justify-items: start;
      text-align: left;
    }

    .category-filters,
    .excluded-disclosure,
    .date-head,
    .record-rows {
      padding-inline: var(--space-4);
    }

    .record-list {
      max-height: 520px;
    }

    .record-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
    }

    .record-actions,
    .invoice-row > .status-chip {
      grid-column: 1 / -1;
      justify-items: start;
      justify-self: start;
    }
  }
</style>
