<script lang="ts">
  import { onMount } from "svelte";
  import AllocationDonutCard from "$lib/overview/components/AllocationDonutCard.svelte";
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import OverviewSankeyCard from "$lib/overview/components/OverviewSankeyCard.svelte";
  import SnapshotSparkline from "$lib/overview/components/SnapshotSparkline.svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    allExchangeRatesMissing,
    convertDailyHistoryRows,
    dailyHistoryCurrencies,
  } from "$lib/overview/exchange-rate-display.ts";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import { historyPointKey, type SummaryMetricDto } from "$lib/shared-ledger/types.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";

  const dailyCurrencyStorageKey = "overview.dailyAssetChanges.currency";

  export let overview: OverviewPageDto;

  let snapshotCurrency = "TWD";
  let dailyCurrency = "TWD";

  $: metrics = overview.summary.slice(0, 3).map((metric) => translateSummaryMetric(metric, $t));
  $: netMetric = metrics[0] ?? null;
  $: netAmounts = netMetric?.amounts ?? [];
  $: sideValue = formatAmountLines(netAmounts.slice(0, 1));
  $: sideSub =
    netAmounts.slice(1).map((amount) => formatMoney(amount)).join(" / ") ||
    $t.common.importedAt(formatImportedAt(overview.importedAt));
  $: sideSubSensitive = netAmounts.length > 1;
  $: history = overview.dailyHistory;
  $: dailyCurrencies = dailyHistoryCurrencies(history);
  $: if (!dailyCurrencies.includes(dailyCurrency)) dailyCurrency = "TWD";
  $: convertedDailyHistory = convertDailyHistoryRows(
    history,
    overview.exchangeRates,
    dailyCurrency,
  ).rows;
  $: twdDailyHistory = convertDailyHistoryRows(
    history,
    overview.exchangeRates,
    "TWD",
  ).rows;
  $: allDailyRatesMissing = allExchangeRatesMissing(twdDailyHistory);
  $: snapshotHistory = [...history].sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right))).slice(-30);

  onMount(() => {
    const stored = localStorage.getItem(dailyCurrencyStorageKey);
    dailyCurrency = stored && dailyCurrencies.includes(stored) ? stored : "TWD";
  });

  function formatImportedAt(value: string | null) {
    return value
      ? formatUtcDateTime(value, $systemTimezone, $locale).replace(/:\d{2}$/, "")
      : $t.common.notYet;
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function selectDailyCurrency(event: Event) {
    dailyCurrency = selectValue(event);
    localStorage.setItem(dailyCurrencyStorageKey, dailyCurrency);
  }

  function translateSummaryMetric(metric: SummaryMetricDto, dictionary: Translation): SummaryMetricDto {
    return {
      ...metric,
      label: translateKnownLabel(metric.label, dictionary),
      breakdown: metric.breakdown.map((item) => translateBreakdown(item, dictionary)),
    };
  }

  function translateKnownLabel(value: string, dictionary: Translation) {
    return (dictionary.knownLabels as Record<string, string>)[value] ?? value;
  }

  function translateBreakdown(value: string, dictionary: Translation) {
    const assetMatch = value.match(/^(\d+) asset accounts$/);
    if (assetMatch) return dictionary.common.assetAccountCount(Number(assetMatch[1]));
    const debtMatch = value.match(/^(\d+) debt accounts$/);
    if (debtMatch) return dictionary.common.debtAccountCount(Number(debtMatch[1]));
    const countMatch = value.match(/^(Bank|Fund|Brokerage|Foreign|Credit card|Loan|Other) (\d+)$/);
    if (countMatch) return dictionary.common.countLabel(translateKnownLabel(countMatch[1], dictionary), Number(countMatch[2]));
    return value;
  }
</script>

<DashboardShell
  active="overview"
  eyebrow={$t.overview.eyebrow}
  title={$t.overview.title}
  sideLabel={$t.overview.sideLabel}
  {sideValue}
  {sideSub}
  {sideSubSensitive}
  syncLabel={$t.common.importedAt(formatImportedAt(overview.importedAt))}
>
  <div class="content">
    <section aria-label={$t.overview.summaryAria}>
      <SummaryStrip {metrics} />
    </section>

    <section class="grid layout-2">
      <article class="card">
        <div class="panel-title">
          <h2>{$t.overview.snapshotHistory}</h2>
          <label class="chip select-chip" for="snapshot-currency">
            <select
              id="snapshot-currency"
              aria-label={$t.overview.snapshotHistoryCurrency}
              bind:value={snapshotCurrency}
              onchange={(event) => (snapshotCurrency = selectValue(event))}
              oninput={(event) => (snapshotCurrency = selectValue(event))}
            >
              <option>TWD</option>
              <option>JPY</option>
              <option>USD</option>
            </select>
          </label>
          <span class="chip">{$t.common.days30}</span>
        </div>
        <div class="card pad">
          <SnapshotSparkline rows={snapshotHistory} currency={snapshotCurrency} label={$t.overview.snapshotHistory} diverging />
          {#key snapshotCurrency}
            <DailyHistoryTable rows={snapshotHistory} compact netLabel={$t.overview.sideLabel} currency={snapshotCurrency} />
          {/key}
        </div>
      </article>

      <div class="overview-allocation-stack">
        <AllocationDonutCard title={$t.overview.assetAllocation} accounts={overview.accounts} mode="asset" />
        <AllocationDonutCard title={$t.overview.liabilityExposure} accounts={overview.accounts} mode="liability" />
      </div>
    </section>

    <section class="card daily-card">
      <div class="panel-title">
        <h2>{$t.overview.dailyAssetChanges}</h2>
        {#if allDailyRatesMissing}
          <span class="chip missing-rate-status" role="status">
            {$t.overview.exchangeRatesMissingNative}
          </span>
        {:else if dailyCurrencies.length > 1}
          <label class="chip select-chip" for="daily-base-currency">
            {$t.common.base}
            <select
              id="daily-base-currency"
              aria-label={$t.overview.dailyAssetChangesBaseCurrency}
              value={dailyCurrency}
              onchange={selectDailyCurrency}
            >
              {#each dailyCurrencies as currency}
                <option value={currency}>{currency}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if overview.latestExchangeRateDate}
          <span class="chip">
            {$t.overview.exchangeRatesThrough(overview.latestExchangeRateDate)}
          </span>
        {/if}
      </div>
      {#key dailyCurrency}
        <DailyHistoryTable rows={convertedDailyHistory} currency={dailyCurrency} paginate />
      {/key}
    </section>

    {#if overview.sankey}
      <section class="card">
        <div class="panel-title"><h2>{$t.overview.portfolioFlow}</h2></div>
        <div class="card pad overview-sankey-panel">
          <OverviewSankeyCard graph={overview.sankey} currency="TWD" />
        </div>
      </section>
    {/if}
  </div>
</DashboardShell>

<style>
  .overview-allocation-stack {
    min-width: 0;
    display: grid;
    gap: var(--space-4);
  }

  .missing-rate-status {
    color: var(--danger);
    border-color: color-mix(in oklch, var(--danger) 28%, var(--border));
    background: color-mix(in oklch, var(--danger) 9%, white);
  }

  .overview-sankey-panel {
    overflow: hidden;
  }
</style>
