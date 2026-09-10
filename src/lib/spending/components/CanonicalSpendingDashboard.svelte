<script lang="ts">
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    aggregateCanonicalByMonth,
    canonicalSpendingCategoryMatches,
    scopeCanonicalSpendingView,
  } from "../canonical-view.ts";
  import type {
    CanonicalSpendingAmountDto,
    CanonicalSpendingRecordDto,
    CanonicalSpendingView,
  } from "../model.ts";

  export let spending: CanonicalSpendingView;

  let selectedMonth: string | undefined;
  let selectedCategory: string | null | undefined;
  let previousSpending: CanonicalSpendingView | undefined;

  $: if (previousSpending !== spending) {
    previousSpending = spending;
    selectedMonth = undefined;
    selectedCategory = undefined;
  }
  $: months = [...new Set(spending.transactions
    .filter((record) => record.inclusion !== "excluded")
    .map((record) => record.date.slice(0, 7)))].sort();
  $: activeMonth = selectedMonth ?? spending.selectedMonth ?? months.at(-1) ?? null;
  $: activeCategory = selectedCategory === undefined ? spending.selectedCategory : selectedCategory;
  $: period = scopeCanonicalSpendingView(spending, activeMonth);
  $: policyLabel = $locale === "zh-TW" ? "已入帳流出總額" : "Gross posted outflow";
  $: visibleTransactions = period.transactions.filter((record) =>
    record.inclusion !== "excluded" && canonicalSpendingCategoryMatches(record, activeCategory),
  );
  $: categoryCodes = [...new Set(period.includedTransactions.flatMap((record) => {
    if (record.category.mode === "single" && record.category.code) return [record.category.code];
    if (record.category.mode === "allocated") return record.category.components.map((component) => component.code);
    return [];
  }))].sort((left, right) => left.localeCompare(right));
  $: monthTotals = aggregateCanonicalByMonth(spending.includedTransactions);
  $: categoryTotals = [
    ...period.categoryTotalsByCurrency.map((row) => ({
      label: categoryText(row.labels, row.categoryCode),
      amount: row.amount,
      code: row.categoryCode,
    })),
    ...period.unclassifiedByCurrency.map((amount) => ({
      label: $locale === "zh-TW" ? "未分類" : "Unclassified",
      amount,
      code: "__unclassified",
    })),
  ];
  $: visibleCategoryTotals = activeCategory
    ? categoryTotals.filter((row) => row.code === activeCategory)
    : categoryTotals;

  function amountText(amount: CanonicalSpendingAmountDto) {
    return formatMoney(amount, { locale: $locale });
  }

  function monthLabel(month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    return year && monthNumber
      ? new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, monthNumber - 1, 1)))
      : month;
  }

  function categoryLabel(record: CanonicalSpendingRecordDto) {
    if (record.category.mode === "absent") return $locale === "zh-TW" ? "未分類" : "Unclassified";
    if (record.category.mode === "single") return categoryText(record.category.labels, record.category.code);
    return record.category.components.map((component) => categoryText(component.labels, component.code)).join(" · ");
  }

  function categoryLabelForCode(code: string) {
    for (const record of period.includedTransactions) {
      if (record.category.mode === "single" && record.category.code === code)
        return categoryText(record.category.labels, code);
      if (record.category.mode === "allocated") {
        const component = record.category.components.find((candidate) => candidate.code === code);
        if (component) return categoryText(component.labels, code);
      }
    }
    return categoryText(null, code);
  }

  function categoryText(
    labels: { en: string; zhHant: string } | null,
    code: string | null,
  ) {
    if (labels) return $locale === "zh-TW" ? labels.zhHant : labels.en;
    if (!code) return $locale === "zh-TW" ? "未分類" : "Unclassified";
    return code.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
  }

  function statusLabel(record: CanonicalSpendingRecordDto) {
    if (record.inclusion === "eligibility-gap") return $locale === "zh-TW" ? "資格缺口" : "Eligibility gap";
    return $locale === "zh-TW" ? "已納入" : "Included";
  }

  function barWidth(
    amount: CanonicalSpendingAmountDto,
    rows: readonly { amount: CanonicalSpendingAmountDto }[],
  ) {
    const max = Math.max(
      ...rows
        .filter((row) => row.amount.currency === amount.currency)
        .filter((row) => Number.isFinite(row.amount.value))
        .map((row) => row.amount.value),
      0,
    );
    return max > 0 && Number.isFinite(amount.value) ? Math.max(3, amount.value / max * 100) : 0;
  }
</script>

<DashboardShell
  active="spending"
  eyebrow={$t.spending.eyebrow}
  title={$t.spending.title}
  sideLabel={policyLabel}
  sideValue={period.totalsByCurrency.length > 0
    ? period.totalsByCurrency.map(amountText).join(" / ")
    : "--"}
  sideSub={period.totalStatus === "complete"
    ? ($locale === "zh-TW" ? "已入帳流出總額" : "Posted outflow total")
    : ($locale === "zh-TW" ? "總額不完整" : "Total incomplete")}
>
  <div class="content spending-dashboard canonical-spending" data-spending-canonical>
    <section class="card canonical-policy-card" data-policy-id={spending.policy.id}>
      <div>
        <p class="eyebrow">{$locale === "zh-TW" ? "支出範圍" : "Spending scope"}</p>
        <h2>{policyLabel}</h2>
        <p class="panel-meta">
          {$locale === "zh-TW"
            ? "只計入已入帳的流出交易；不同幣別分開顯示。"
            : "Only posted outflows are counted; currencies stay separate."}
        </p>
      </div>
      <span class:incomplete={period.totalStatus === "incomplete"} class="canonical-total-status" data-total-status={period.totalStatus}>
        {period.totalStatus === "complete"
          ? ($locale === "zh-TW" ? "總額完整" : "Complete total")
          : ($locale === "zh-TW" ? "總額不完整" : "Incomplete total")}
      </span>
    </section>

    {#if period.reportEligibility.status === "incomplete"}
      <section class="card canonical-gap-card" data-eligibility-gap role="status">
        <strong>{$locale === "zh-TW" ? "資料資格缺口" : "Eligibility coverage gap"}</strong>
        <span>
          {$locale === "zh-TW"
            ? `${period.reportEligibility.gapCount} 筆、${period.reportEligibility.gapAmountByCurrency.map(amountText).join(" / ")} 缺少判定是否列入支出所需資料。`
            : `${period.reportEligibility.gapCount} transaction(s), ${period.reportEligibility.gapAmountByCurrency.map(amountText).join(" / ")} are missing data needed to decide whether they belong in spending.`}
        </span>
      </section>
    {/if}

    <section class="card canonical-summary-card">
      <div class="panel-title">
        <div>
          <p class="eyebrow">{$locale === "zh-TW" ? "Totals" : "Totals"}</p>
          <h2>{policyLabel}</h2>
        </div>
        <span class="panel-meta">{activeMonth ? monthLabel(activeMonth) : ($locale === "zh-TW" ? "全部月份" : "All months")} · {$locale === "zh-TW" ? "全部分類" : "All categories"} · {period.classificationCoverage.includedCount} {$locale === "zh-TW" ? "筆已納入" : "included"}</span>
      </div>
      <div class="canonical-amount-list">
        {#each period.totalsByCurrency as amount (amount.currency)}
          <div class="canonical-amount-row">
            <span>{amount.currency}</span>
            <strong class="money" data-sensitive>{amountText(amount)}</strong>
          </div>
        {:else}
          <span class="panel-meta">{$locale === "zh-TW" ? "尚無支出資料" : "No spending data yet."}</span>
        {/each}
      </div>
      <div class="canonical-coverage-grid">
        <div><span>{$locale === "zh-TW" ? "已分類" : "Classified"}</span><strong>{period.classificationCoverage.classifiedCount}</strong></div>
        <div data-unclassified><span>{$locale === "zh-TW" ? "未分類" : "Unclassified"}</span><strong>{period.classificationCoverage.unclassifiedCount}</strong></div>
        <div><span>{$locale === "zh-TW" ? "未分類金額" : "Unclassified amount"}</span><strong>{period.unclassifiedByCurrency.map(amountText).join(" / ") || "--"}</strong></div>
      </div>
    </section>

    {#if months.length > 0}
      <div class="canonical-month-tabs" role="group" aria-label={$locale === "zh-TW" ? "月份" : "Month"}>
        {#each months as month}
          <button type="button" class="filter-btn" aria-pressed={month === activeMonth} onclick={() => selectedMonth = month}>
            {monthLabel(month)}
          </button>
        {/each}
      </div>
    {/if}

    <section class="card canonical-chart-card" aria-label={$locale === "zh-TW" ? "每月已入帳流出總額" : "Monthly gross posted outflow chart"}>
      <div class="panel-title">
        <div>
          <p class="eyebrow">{$locale === "zh-TW" ? "圖表" : "Chart"}</p>
          <h2>{$locale === "zh-TW" ? "每月支出" : "Monthly outflow"}</h2>
        </div>
        <span class="panel-meta">{$locale === "zh-TW" ? "全部月份・全部分類・幣別分開" : "All months · all categories · currencies remain separate"}</span>
      </div>
      <div class="canonical-chart" data-chart>
        {#each monthTotals as row (row.month + row.amount.currency)}
          <div class="canonical-chart-row">
            <span>{monthLabel(row.month)} · {row.amount.currency}</span>
            <div class="canonical-bar-track"><span style={`width: ${barWidth(row.amount, monthTotals)}%`}></span></div>
            <strong class="money" data-sensitive>{amountText(row.amount)}</strong>
          </div>
        {:else}
          <span class="panel-meta">{$locale === "zh-TW" ? "尚無圖表資料" : "No chart data yet."}</span>
        {/each}
      </div>
      <div class="canonical-category-chart" data-category-chart>
        <h3>{$locale === "zh-TW" ? "依分類" : "By category"}</h3>
        <p class="panel-meta">{activeMonth ? monthLabel(activeMonth) : ($locale === "zh-TW" ? "全部月份" : "All months")}</p>
        {#each visibleCategoryTotals as row (row.code + row.amount.currency)}
          <div class="canonical-chart-row">
            <span>{row.label} · {row.amount.currency}</span>
            <div class="canonical-bar-track"><span style={`width: ${barWidth(row.amount, visibleCategoryTotals)}%`}></span></div>
            <strong class="money" data-sensitive>{amountText(row.amount)}</strong>
          </div>
        {:else}
          <span class="panel-meta">{$locale === "zh-TW" ? "尚無分類資料" : "No category data yet."}</span>
        {/each}
      </div>
    </section>

    <section class="card canonical-records-card">
      <div class="panel-title">
        <div>
          <p class="eyebrow">{$locale === "zh-TW" ? "交易" : "Transactions"}</p>
          <h2>{activeMonth ? monthLabel(activeMonth) : ($locale === "zh-TW" ? "交易" : "Transactions")}</h2>
        </div>
        <span class="panel-meta">{visibleTransactions.length} {$locale === "zh-TW" ? "筆" : "records"}</span>
      </div>
      <div class="canonical-filter-row" role="group" aria-label={$locale === "zh-TW" ? "分類篩選" : "Category filter"}>
        <button type="button" class="filter-btn" aria-pressed={!activeCategory} onclick={() => selectedCategory = null}>{$locale === "zh-TW" ? "全部" : "All"}</button>
        {#each categoryCodes as categoryCode}
          <button type="button" class="filter-btn" aria-pressed={activeCategory === categoryCode} onclick={() => selectedCategory = categoryCode}>{categoryLabelForCode(categoryCode)}</button>
        {/each}
        {#if period.classificationCoverage.unclassifiedCount > 0}
          <button type="button" class="filter-btn" aria-pressed={activeCategory === "__unclassified"} onclick={() => selectedCategory = "__unclassified"}>{$locale === "zh-TW" ? "未分類" : "Unclassified"}</button>
        {/if}
      </div>
      <div class="canonical-record-list">
        {#each visibleTransactions as record (record.transactionId)}
          <article class:gap-record={record.inclusion === "eligibility-gap"} class="canonical-record" data-inclusion={record.inclusion}>
            <div class="canonical-record-main">
              <strong>{record.display.label ?? ($locale === "zh-TW" ? "未提供商戶名稱" : "Merchant unavailable")}</strong>
              <span>{record.date}{record.accountNumber ? ` · ${record.accountNumber}` : ""}</span>
              {#if record.display.kind === "source_description"}
                <span>{$locale === "zh-TW" ? "來源交易描述" : "Source transaction description"}</span>
              {/if}
              <span>{categoryLabel(record)}{record.tags.length ? ` · ${record.tags.map((tag) => tag.label).join(" · ")}` : ""}</span>
              {#if record.category.mode === "allocated"}
                <div class="canonical-allocation-list" data-allocation-components>
                  {#each record.category.components as component (component.code)}
                    <span>{categoryText(component.labels, component.code)}: {amountText(component.amount)}</span>
                  {/each}
                </div>
              {/if}
            </div>
            <div class="canonical-record-side">
              <strong class="money" data-sensitive>{amountText(record.amount)}</strong>
              <span class:gap-label={record.inclusion === "eligibility-gap"} class="status-chip">{statusLabel(record)}</span>
            </div>
          </article>
        {:else}
          <div class="invoice-empty"><strong>{$locale === "zh-TW" ? "沒有符合的交易" : "No matching transactions"}</strong></div>
        {/each}
      </div>
    </section>
  </div>
</DashboardShell>

<style>
  .canonical-spending {
    display: grid;
    gap: var(--space-5);
  }

  .canonical-policy-card,
  .canonical-gap-card,
  .canonical-summary-card,
  .canonical-chart-card,
  .canonical-records-card {
    min-width: 0;
    padding: var(--space-5);
  }

  .canonical-policy-card,
  .canonical-gap-card,
  .canonical-amount-row,
  .canonical-chart-row,
  .canonical-record {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .canonical-policy-card h2,
  .canonical-summary-card h2,
  .canonical-chart-card h2,
  .canonical-records-card h2 {
    margin: 0;
  }

  .canonical-gap-card {
    align-items: flex-start;
    flex-direction: column;
    border-color: color-mix(in srgb, var(--danger, #b42318) 35%, var(--border));
  }

  .canonical-gap-card span {
    color: var(--muted);
  }

  .canonical-total-status {
    color: var(--success, #087443);
    font-size: 12px;
    font-weight: 700;
  }

  .canonical-total-status.incomplete,
  .gap-label {
    color: var(--danger, #b42318);
  }

  .canonical-amount-list,
  .canonical-chart,
  .canonical-record-list {
    display: grid;
    gap: var(--space-3);
  }

  .canonical-amount-list {
    margin-top: var(--space-4);
  }

  .canonical-amount-row {
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-2);
  }

  .canonical-coverage-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .canonical-coverage-grid > div {
    display: grid;
    gap: 3px;
    color: var(--muted);
    font-size: 12px;
  }

  .canonical-coverage-grid strong {
    color: var(--fg);
    font-size: 14px;
  }

  .canonical-month-tabs,
  .canonical-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .canonical-chart {
    margin-top: var(--space-4);
  }

  .canonical-category-chart {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .canonical-category-chart h3 {
    margin: 0;
    font-size: 13px;
  }

  .canonical-chart-row {
    min-width: 0;
    font-size: 12px;
  }

  .canonical-chart-row > span {
    flex: 0 0 160px;
    color: var(--muted);
  }

  .canonical-chart-row > strong {
    flex: 0 0 auto;
    min-width: 90px;
    text-align: right;
  }

  .canonical-bar-track {
    flex: 1;
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .canonical-bar-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }

  .canonical-records-card .panel-title {
    margin-bottom: var(--space-4);
  }

  .canonical-filter-row {
    margin-bottom: var(--space-4);
  }

  .canonical-record {
    align-items: flex-start;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }

  .canonical-record-main,
  .canonical-record-side {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .canonical-record-main > strong {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .canonical-record-main > span {
    color: var(--muted);
    font-size: 12px;
  }

  .canonical-allocation-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    color: var(--muted);
    font-size: 12px;
  }

  .canonical-record-side {
    justify-items: end;
    text-align: right;
  }

  .canonical-record-side > strong {
    white-space: nowrap;
  }

  .gap-record {
    background: color-mix(in srgb, var(--danger, #b42318) 4%, transparent);
  }

  @media (max-width: 680px) {
    .canonical-policy-card,
    .canonical-gap-card,
    .canonical-record {
      align-items: flex-start;
      flex-direction: column;
    }

    .canonical-record-side {
      justify-items: start;
      text-align: left;
    }

    .canonical-chart-row > span {
      flex-basis: 112px;
    }

    .canonical-coverage-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
