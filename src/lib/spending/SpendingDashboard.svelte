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
  import type {
    SpendingInvoiceDto,
    SpendingPageDto,
  } from "./model.ts";

  export let spending: SpendingPageDto;

  let selectedMonth: string | undefined;
  let selectedCategory: SpendingCategory | undefined;
  let monthTabs: HTMLDivElement | null = null;
  let categoryFilters: HTMLDivElement | null = null;
  let allCategoryFilter: HTMLButtonElement | null = null;
  let invoiceList: HTMLDivElement | null = null;
  let dailyModalOpen = false;
  let selectedInvoiceKey: string | undefined;
  let dailyModalTrigger: HTMLButtonElement | null = null;
  let invoiceModalTrigger: HTMLButtonElement | null = null;
  let savingItemKeys = new Set<string>();
  let errorItemKeys = new Set<string>();

  $: model = spending;
  $: monthFormatter = new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" });
  $: invoiceDateFormatter = new Intl.DateTimeFormat($locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Taipei",
  });
  $: activeMonthLabel = model.selectedMonth ? formatMonth(model.selectedMonth) : "";
  $: sideValue = model.selectedMonth
    ? formatMoney(
        { currency: "TWD", value: model.selectedMonthSummary.total },
        { locale: $locale },
      )
    : "--";
  $: sideSub = model.selectedMonth
    ? $t.spending.sideSub(activeMonthLabel, model.selectedMonthSummary.invoiceCount)
    : $t.spending.noSpendingTitle;
  $: datasetStatus = model.months.length > 0
    ? $t.spending.datasetStatus(
        spending.invoices.length,
        formatMonth(model.months[0]),
        formatMonth(model.months.at(-1) ?? model.months[0]),
      )
    : $t.spending.noSpendingTitle;
  $: invoiceRows = [...model.invoices].sort(
    (left, right) => right.issuedAt - left.issuedAt || right.invoiceId.localeCompare(left.invoiceId),
  );
  $: selectedInvoice = selectedInvoiceKey
    ? spending.invoices.find((invoice) => invoice.invoiceKey === selectedInvoiceKey) ?? null
    : null;

  onMount(() => {
    void tick().then(scrollSelectedMonthIntoView);
  });

  async function selectMonth(month: string) {
    const previousSpending = spending;
    const previousMonth = selectedMonth;
    const previousCategory = selectedCategory;
    selectedMonth = month;
    selectedCategory = undefined;
    try {
      spending = await window.octopusBeak.spending.load({ selectedMonth: month });
      selectedMonth = undefined;
    } catch {
      spending = previousSpending;
      selectedMonth = previousMonth;
      selectedCategory = previousCategory;
    }
    await tick();
    scrollSelectedMonthIntoView();
  }

  function selectCategory(category: SpendingCategory | undefined) {
    selectedCategory = category;
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
    const fallback = invoiceList?.querySelector<HTMLButtonElement>(".invoice-row")
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

  function formatInvoiceDate(unixSeconds: number) {
    return invoiceDateFormatter.format(new Date(unixSeconds * 1000));
  }

  function invoiceCategories(invoice: SpendingInvoiceDto): SpendingCategory[] {
    const categories = SPENDING_CATEGORY_IDS.filter((category) =>
      invoice.items.some((item) => item.category === category),
    );
    return categories.length > 0 ? categories : ["other"];
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
              <span>{$t.spending.invoiceCount(model.selectedMonthSummary.invoiceCount)}</span>
            </div>
          </div>
          <div class="invoice-heading">
            <p class="eyebrow">{$t.spending.invoiceEyebrow}</p>
            <h2>{$t.spending.invoiceRecords}</h2>
            <p class="panel-meta" role="status" aria-live="polite">{$t.spending.resultCount(invoiceRows.length)}</p>
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
              aria-pressed={!selectedCategory}
              onclick={() => selectCategory(undefined)}
            >
              {$t.spending.allCategories}
            </button>
            {#each model.presentCategories as category}
              <button
                class="filter-btn"
                type="button"
                aria-pressed={selectedCategory === category}
                onclick={() => selectCategory(category)}
              >
                {$t.spending.categories[category]}
              </button>
            {/each}
          </div>
        </div>

        <div class="invoice-list" bind:this={invoiceList}>
          {#if invoiceRows.length > 0}
            {#each invoiceRows as invoice (invoice.invoiceKey)}
              <button
                class="invoice-row"
                type="button"
                aria-label={$t.spending.invoiceRowAria(
                  invoice.invoiceId,
                  invoice.sellerName || $t.spending.unknownSeller,
                  formatMoney({ currency: "TWD", value: invoice.amount }, { locale: $locale }),
                )}
                onclick={(event) => openInvoiceModal(event, invoice.invoiceKey)}
              >
                <div class="invoice-main">
                  <div class="invoice-idline">
                    <strong>{invoice.invoiceId}</strong>
                    {#each invoiceCategories(invoice) as category}
                      <span class="category-chip category-{category}">
                        {$t.spending.categories[category]}
                      </span>
                    {/each}
                  </div>
                  <p class="merchant-name">{invoice.sellerName || $t.spending.unknownSeller}</p>
                  <p class="invoice-sub">
                    {formatInvoiceDate(invoice.issuedAt)} / {$t.spending.itemCount(invoice.items.length)}
                  </p>
                </div>
                <strong class="invoice-amount money" data-sensitive>
                  {formatMoney(
                    { currency: "TWD", value: invoice.amount },
                    { locale: $locale },
                  )}
                </strong>
              </button>
            {/each}
          {:else}
            <div class="invoice-empty">
              <strong>{$t.spending.noInvoicesTitle}</strong>
              <span>{$t.spending.noInvoicesBody}</span>
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
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .category-filters {
    min-width: 0;
    display: flex;
    gap: var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .category-filters .filter-btn {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .invoice-list {
    max-height: 620px;
    display: grid;
    align-content: start;
    overflow-y: auto;
  }

  .invoice-row {
    width: 100%;
    min-width: 0;
    min-height: 92px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
    border: 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
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

  .invoice-row:last-child {
    border-bottom: 0;
  }

  .invoice-main {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .invoice-idline {
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .invoice-idline > strong {
    font-family: var(--font-mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
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

  .merchant-name,
  .invoice-sub {
    margin: 0;
  }

  .merchant-name {
    overflow: hidden;
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .invoice-sub {
    color: var(--muted);
    font-size: 12px;
  }

  .invoice-amount {
    align-self: center;
    font-size: 14px;
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

    .invoice-tools,
    .invoice-row {
      padding-inline: var(--space-4);
    }

    .invoice-list {
      max-height: 520px;
    }

    .invoice-row {
      min-height: 100px;
      gap: var(--space-3);
    }
  }
</style>
