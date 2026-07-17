<script lang="ts">
  import { onMount, tick } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    isSpendingCategory,
    type SpendingCategory,
  } from "./categories.ts";
  import DailySpendingModal from "./components/DailySpendingModal.svelte";
  import AccountTransactionReviewModal from "./components/AccountTransactionReviewModal.svelte";
  import InvoiceDetailModal from "./components/InvoiceDetailModal.svelte";
  import SpendingBarChart from "./components/SpendingBarChart.svelte";
  import { applySpendingAccountOverride } from "./model.ts";
  import type {
    SpendingAccountRecord,
    SpendingDateGroup,
    SpendingPageDto,
    SpendingSource,
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
  let selectedAccountStatementRowId: string | undefined;
  let accountModalTrigger: HTMLButtonElement | null = null;
  let savingItemKeys = new Set<string>();
  let errorItemKeys = new Set<string>();
  let savingRecordIds = new Set<string>();
  let errorRecordIds = new Set<string>();
  let showExcludedRecords = false;
  let selectedSource: SpendingSource | undefined;
  let loadRequestSequence = 0;

  $: model = spending;
  $: monthFormatter = new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" });
  $: recordDateFormatter = new Intl.DateTimeFormat($locale, {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  });
  $: shortDateFormatter = new Intl.DateTimeFormat($locale, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  $: weekdayFormatter = new Intl.DateTimeFormat($locale, { weekday: "long", timeZone: "UTC" });
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
  $: visibleRecordGroups = buildVisibleRecordGroups(
    model,
    activeCategory,
    showExcludedRecords,
    selectedSource,
  );
  $: visibleRecordCount = visibleRecordGroups.reduce((count, group) => count + group.records.length, 0);
  $: selectedInvoice = selectedInvoiceKey
    ? spending.invoices.find((invoice) => invoice.invoiceKey === selectedInvoiceKey) ?? null
    : null;
  $: selectedAccountRecord = selectedAccountStatementRowId
    ? model.accountRecords.find((record) => record.statementRowId === selectedAccountStatementRowId) ?? null
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
  ): Promise<boolean> {
    if (savingRecordIds.size > 0) return false;
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
      return true;
    } catch {
      spending = snapshot;
      errorRecordIds = new Set(errorRecordIds).add(record.statementRowId);
      return false;
    } finally {
      savingRecordIds = new Set(savingRecordIds);
      savingRecordIds.delete(record.statementRowId);
    }
  }

  function openAccountModal(event: MouseEvent, statementRowId: string) {
    accountModalTrigger = event.currentTarget as HTMLButtonElement;
    selectedAccountStatementRowId = statementRowId;
  }

  async function closeAccountModal() {
    const trigger = accountModalTrigger;
    selectedAccountStatementRowId = undefined;
    accountModalTrigger = null;
    await tick();
    const fallback = categoryFilters?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?? allCategoryFilter;
    (trigger?.isConnected ? trigger : fallback)?.focus();
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

  function formatShortDate(date: string) {
    return shortDateFormatter.format(new Date(`${date}T00:00:00Z`));
  }

  function formatWeekday(date: string) {
    return weekdayFormatter.format(new Date(`${date}T00:00:00Z`));
  }

  function buildVisibleRecordGroups(
    source: SpendingPageDto,
    category: SpendingCategory | undefined,
    includeExcluded: boolean,
    recordSource: SpendingSource | undefined,
  ): SpendingDateGroup[] {
    const displayedKeys = new Set(source.recordsByDate.flatMap((group) => group.records)
      .map((record) => record.key));
    const missingExcluded = Map.groupBy(source.excludedAccountRecords.filter((record) =>
      (!recordSource || recordSource === "account")
      && !displayedKeys.has(record.key)
      && (!category || record.category === category)
    ), (record) => record.date);
    return source.recordsByDate.map((group) => {
      const extra = missingExcluded.get(group.date) ?? [];
      const records = [
        ...group.records.filter((record) =>
          (!recordSource || record.source === recordSource)
          && (includeExcluded || record.state !== "excluded")
        ),
        ...(includeExcluded ? extra : []),
      ];
      return {
        ...group,
        records,
        includedTotal: records.reduce(
          (total, record) => record.state === "included" ? total + record.amount : total,
          0,
        ),
        excludedCount: group.excludedCount + extra.length,
      };
    }).filter((group) => group.records.length > 0);
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
            interaction="pan-zoom"
            selectedKey={selectedMonth ?? model.selectedMonth}
            onBarClick={(month) => void selectMonth(month)}
          />
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
            </div>
          </div>
          <div class="invoice-heading">
            <p class="eyebrow">{$t.spending.recordsEyebrow}</p>
            <h2>{$t.spending.dailyRecords}</h2>
            <p class="panel-meta" role="status" aria-live="polite">
              {$t.spending.resultCount(visibleRecordCount)}
            </p>
            {#if model.excludedAccountRecords.length > 0}
              <div class="excluded-control">
                <button
                  class="excluded-button"
                  type="button"
                  data-excluded-toggle
                  aria-label={$t.spending.excludedButtonAria(model.excludedAccountRecords.length)}
                  aria-expanded={showExcludedRecords}
                  onclick={() => showExcludedRecords = !showExcludedRecords}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 5h20"></path>
                    <path d="M6 12h12"></path>
                    <path d="M9 19h6"></path>
                  </svg>
                </button>
                <span class="excluded-tooltip" role="tooltip">
                  {$t.spending.excludedTooltip(model.excludedAccountRecords.length)}
                </span>
              </div>
            {/if}
          </div>
        </div>

        <div class="invoice-tools">
          <div class="source-filters" role="group" aria-label={$t.spending.sourceFilterAria}>
            <button
              class="filter-btn"
              type="button"
              data-source-filter="all"
              disabled={transactionSaving}
              aria-pressed={!selectedSource}
              onclick={() => selectedSource = undefined}
            >{$t.spending.allSources}</button>
            <button
              class="filter-btn"
              type="button"
              data-source-filter="invoice"
              disabled={transactionSaving}
              aria-pressed={selectedSource === "invoice"}
              onclick={() => selectedSource = "invoice"}
            >{$t.spending.invoiceSource}</button>
            <button
              class="filter-btn"
              type="button"
              data-source-filter="account"
              disabled={transactionSaving}
              aria-pressed={selectedSource === "account"}
              onclick={() => selectedSource = "account"}
            >{$t.spending.accountSource}</button>
          </div>
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
        </div>

        <div class="record-list" bind:this={recordList} data-spending-ledger>
          <div class="ledger-columns" aria-hidden="true">
            <span data-ledger-column>{$t.spending.ledgerDate}</span>
            <span data-ledger-column>{$t.spending.ledgerTransaction}</span>
            <span data-ledger-column>{$t.spending.ledgerAmount}</span>
          </div>
          {#if visibleRecordGroups.length > 0}
            {#each visibleRecordGroups as group (group.date)}
              <section class="record-day" aria-labelledby={`spending-day-${group.date}`}>
                <header class="day-summary" id={`spending-day-${group.date}`} data-day-summary>
                  <span>{formatShortDate(group.date)}</span>
                  <strong class="money" data-sensitive>
                    {formatMoney({ currency: "TWD", value: group.includedTotal }, { locale: $locale })}
                  </strong>
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
                        <span class="record-date">
                          <strong>{formatShortDate(record.date)}</strong>
                          <small>{formatWeekday(record.date)}</small>
                        </span>
                        <div class="record-main">
                          <strong class="merchant-name">{record.label}</strong>
                          <div class="record-meta">
                            <span>{$t.spending.invoiceSource}</span>
                            {#each record.categories as category}
                              <span class="category-chip category-{category}">
                                {$t.spending.categories[category]}
                              </span>
                            {/each}
                            <span class="status-chip included">{$t.spending.invoiceStatus}</span>
                          </div>
                        </div>
                        <strong class="record-amount money" data-sensitive>
                          {formatMoney({ currency: "TWD", value: record.amount }, { locale: $locale })}
                        </strong>
                      </button>
                    {:else}
                      <button
                        class="record-row account-row"
                        class:pending-row={record.state === "pending"}
                        type="button"
                        data-account-row={record.statementRowId}
                        disabled={transactionSaving}
                        aria-label={$t.spending.reviewTransactionAria(
                          record.label,
                          formatRecordDate(record.date),
                          formatMoney({ currency: record.currency, value: record.amount }, { locale: $locale }),
                        )}
                        onclick={(event) => openAccountModal(event, record.statementRowId)}
                      >
                        <span class="record-date">
                          <strong>{formatShortDate(record.date)}</strong>
                          <small>{record.time || formatWeekday(record.date)}</small>
                        </span>
                        <div class="record-main">
                          <strong class="merchant-name">{record.label}</strong>
                          <div class="record-meta">
                            <span>{$t.spending.accountSource}</span>
                            {#if record.accountNumber}<span>· {record.accountNumber}</span>{/if}
                            <span class="category-chip category-{record.category}">
                              {$t.spending.categories[record.category]}
                            </span>
                            <span class="status-chip {record.state}">{$t.spending.states[record.state]}</span>
                          </div>
                          {#if errorRecordIds.has(record.statementRowId)}
                            <span class="record-error" role="alert">{$t.spending.overrideError}</span>
                          {/if}
                        </div>
                        <strong class="record-amount money" data-sensitive>
                          {formatMoney({ currency: record.currency, value: record.amount }, { locale: $locale })}
                        </strong>
                      </button>
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

    {#if selectedAccountRecord}
      <AccountTransactionReviewModal
        record={selectedAccountRecord}
        saving={savingRecordIds.has(selectedAccountRecord.statementRowId)}
        error={errorRecordIds.has(selectedAccountRecord.statementRowId)}
        onClose={closeAccountModal}
        onSave={updateTransactionState}
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
    align-items: end;
    justify-content: space-between;
    gap: var(--space-4);
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
  .invoice-tools::-webkit-scrollbar,
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

  .invoice-heading {
    justify-items: end;
    text-align: right;
  }

  .excluded-control {
    position: relative;
    margin-top: 4px;
  }

  .excluded-button {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .excluded-button[aria-expanded="true"] {
    background: var(--surface-soft);
  }

  .excluded-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 2;
  }

  .excluded-tooltip {
    position: absolute;
    right: 0;
    bottom: calc(100% + 7px);
    z-index: 4;
    width: max-content;
    max-width: min(280px, 80vw);
    padding: 7px 9px;
    border-radius: var(--radius-sm);
    background: color-mix(in oklch, var(--fg) 94%, transparent);
    color: white;
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    opacity: 0;
    pointer-events: none;
    transform: translateY(3px);
    transition: opacity 120ms ease, transform 120ms ease;
  }

  .excluded-control:hover .excluded-tooltip,
  .excluded-control:focus-within .excluded-tooltip {
    opacity: 1;
    transform: translateY(0);
  }

  .invoice-tools {
    display: flex;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--border);
  }

  .source-filters,
  .category-filters {
    min-width: 0;
    display: flex;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
  }

  .source-filters {
    flex: 0 0 auto;
    padding-right: var(--space-4);
    border-right: 1px solid var(--border);
  }

  .category-filters {
    flex: 0 0 auto;
    padding-left: var(--space-4);
  }

  .source-filters .filter-btn,
  .category-filters .filter-btn {
    flex: 0 0 auto;
    white-space: nowrap;
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

  .ledger-columns,
  .day-summary,
  .record-row {
    grid-template-columns: 120px minmax(0, 1fr) auto;
  }

  .ledger-columns,
  .day-summary {
    display: grid;
    align-items: center;
    gap: var(--space-4);
    padding: 9px var(--space-5);
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
  }

  .ledger-columns {
    position: sticky;
    top: 0;
    z-index: 3;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 700;
  }

  .ledger-columns span:last-child,
  .day-summary strong {
    text-align: right;
  }

  .day-summary {
    border-bottom: 1px solid var(--border);
  }

  .day-summary span {
    grid-column: 2;
  }

  .day-summary strong {
    grid-column: 3;
    color: var(--muted);
  }

  .record-rows {
    background: var(--surface);
  }

  .record-row {
    width: 100%;
    min-width: 0;
    min-height: 76px;
    display: grid;
    align-items: center;
    gap: var(--space-4);
    padding: 14px var(--space-5);
    border: 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    text-align: left;
  }

  .pending-row {
    background: color-mix(in oklch, var(--warn) 4%, var(--surface));
  }

  .record-row:hover {
    background: var(--surface-soft);
  }

  .record-row:focus-visible {
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

  .record-date {
    display: grid;
    gap: 1px;
  }

  .record-date strong {
    font-size: 14px;
  }

  .record-date small {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
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
    justify-self: end;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
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

    .invoice-header,
    .spending-panel-title {
      align-items: start;
      flex-direction: column;
    }

    .invoice-heading {
      justify-items: start;
      text-align: left;
    }

    .category-filters,
    .ledger-columns,
    .day-summary,
    .record-row {
      padding-inline: var(--space-4);
    }

    .record-list {
      max-height: 520px;
    }

    .record-row {
      grid-template-columns: 72px minmax(0, 1fr) auto;
      gap: var(--space-3);
    }
  }
</style>
