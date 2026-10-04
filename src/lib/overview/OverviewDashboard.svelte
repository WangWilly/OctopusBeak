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
  import {
    safeSourceGapLabel,
    sourceGapCounts,
  } from "$lib/shared-ledger/account-display.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type {
    DashboardBlockPayload,
    DashboardBlockValueMap,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import {
    resolveOverviewChart,
    resolveOverviewDetails,
    resolveOverviewList,
    resolveOverviewSummary,
  } from "$lib/shared-shell/progressive-dashboard-data.ts";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import {
    createOnboardingTargetRegistry,
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";

  const dailyCurrencyStorageKey = "overview.dailyAssetChanges.currency";
  const sankeyCurrencyStorageKey = "overview.portfolioFlow.currency";

  export let overview: OverviewPageDto;
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onboardingEmptyState = false;

  let snapshotCurrency = "TWD";
  let dailyCurrency = "TWD";
  let sankeyCurrency = "TWD";

  function blockState(key: string): BlockState<DashboardBlockPayload> {
    return blocks[key] ?? { status: "loading" };
  }

  function overviewBlockData<Key extends keyof DashboardBlockValueMap["overview"]>(
    key: Key,
    payload: DashboardBlockPayload | undefined,
  ): DashboardBlockValueMap["overview"][Key] | undefined {
    return payload?.route === "overview" && payload.block === key
      ? payload.data as DashboardBlockValueMap["overview"][Key]
      : undefined;
  }

  function metricsFor(summary: SummaryMetricDto[]) {
    return summary.slice(0, 3).map((metric) => translateSummaryMetric(metric, $t));
  }

  $: metrics = metricsFor(overview.summary);
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
  $: sankeyCurrencies = ["TWD", ...overview.sankeyExchangeRates.map((rate) => rate.currency)];
  $: if (!sankeyCurrencies.includes(sankeyCurrency)) sankeyCurrency = "TWD";
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
  $: gapCounts = sourceGapCounts(overview.sourceGaps);
  $: currentStateLabel = overview.availability === "unavailable"
    ? $t.overview.currentUnavailable
    : overview.sourceGaps.length > 0
      ? $t.overview.currentPartial(gapCounts.currentValue, gapCounts.sourceNotCollected)
      : overview.availability === "awaiting"
        ? $t.overview.currentAwaiting
        : overview.availability === "empty"
          ? $t.overview.currentEmpty
          : $t.overview.currentUnavailable;

  onMount(() => {
    const stored = localStorage.getItem(dailyCurrencyStorageKey);
    dailyCurrency = stored && dailyCurrencies.includes(stored) ? stored : "TWD";
    const storedSankey = localStorage.getItem(sankeyCurrencyStorageKey);
    sankeyCurrency = storedSankey && sankeyCurrencies.includes(storedSankey) ? storedSankey : "TWD";
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

  function selectSankeyCurrency(event: Event) {
    sankeyCurrency = selectValue(event);
    localStorage.setItem(sankeyCurrencyStorageKey, sankeyCurrency);
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
    {#if overview.availability === "empty"}
      <section
        class="card projection-state overview-empty-state"
        role="status"
        data-overview-state="empty"
        use:registerOnboardingTarget={{ registry: onboardingTargets, id: "overview.empty" }}
      >
        {$t.overview.currentEmpty}
      </section>
    {/if}
    {#if overview.coverage !== "complete" && overview.availability !== "empty"}
      <div
        class="projection-state"
        role="status"
        data-overview-state={overview.coverage}
        use:registerOnboardingTarget={{
          registry: onboardingTargets,
          id: onboardingEmptyState ? "overview.empty" : null,
        }}
      >
        <span>{currentStateLabel}</span>
        {#if overview.sourceGaps.length > 0}
          <ul class="projection-gap-list" aria-label={$t.overview.sourceGapsAria}>
            {#each overview.sourceGaps as gap}
              <li>{safeSourceGapLabel(gap)}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    <ProgressiveBlock
      label="summary"
      state={blockState("summary")}
      retry={() => retryBlock("summary")}
      let:data
    >
      {@const summaryBlock = overviewBlockData("summary", data)}
      <section
        aria-label={$t.overview.summaryAria}
        use:registerOnboardingTarget={{ registry: onboardingTargets, id: "overview.summary" }}
      >
        <SummaryStrip metrics={metricsFor(resolveOverviewSummary(overview, summaryBlock))} />
      </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")} let:data>
      {@const chartBlock = overviewBlockData("chart", data)}
      {@const chartData = resolveOverviewChart(overview, chartBlock)}
      {@const chartHistory = chartData.dailyHistory}
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
        {#if chartData.historyAvailability !== "available" || chartHistory.length === 0}
          <div class="card pad projection-state history-state" role="status" data-overview-state="history-unavailable">
            {$t.overview.historyUnavailable}
          </div>
        {:else}
          <div class="card pad">
            <SnapshotSparkline rows={chartHistory.slice(-30)} currency={snapshotCurrency} label={$t.overview.snapshotHistory} diverging />
            {#key snapshotCurrency}
              <DailyHistoryTable rows={chartHistory.slice(-30)} compact netLabel={$t.overview.sideLabel} currency={snapshotCurrency} />
            {/key}
          </div>
        {/if}
      </article>

      <div class="overview-allocation-stack">
        <AllocationDonutCard title={$t.overview.assetAllocation} accounts={chartData.accounts} mode="asset" />
        <AllocationDonutCard title={$t.overview.liabilityExposure} accounts={chartData.accounts} mode="liability" />
      </div>
      </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="list" state={blockState("list")} retry={() => retryBlock("list")} let:data>
      {@const listBlock = overviewBlockData("list", data)}
      {@const listData = resolveOverviewList(overview, listBlock)}
      {@const latestRateDate = listData.latestExchangeRateDate}
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
        {#if latestRateDate}
          <span class="chip">
            {$t.overview.exchangeRatesThrough(latestRateDate)}
          </span>
        {/if}
      </div>
      {#if listData.historyAvailability !== "available" || listData.dailyHistory.length === 0}
        <div class="projection-state history-state" role="status">{$t.overview.historyUnavailable}</div>
      {:else}
        {#key dailyCurrency}
          <DailyHistoryTable rows={listData.dailyHistory ?? convertedDailyHistory} currency={dailyCurrency} paginate />
        {/key}
      {/if}
      </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="details" state={blockState("details")} retry={() => retryBlock("details")} let:data>
      {@const detailsBlock = overviewBlockData("details", data)}
      {@const detailsData = resolveOverviewDetails(overview, detailsBlock)}
      {@const sankey = detailsData.sankey}
      {#if sankey}
        <section class="card sankey-card">
        <div class="panel-title">
          <h2>{$t.overview.portfolioFlow}</h2>
          {#if sankeyCurrencies.length > 1}
            <label class="chip select-chip" for="sankey-base-currency">
              {$t.common.base}
              <select
                id="sankey-base-currency"
                aria-label={$t.overview.portfolioFlowBaseCurrency}
                value={sankeyCurrency}
                onchange={selectSankeyCurrency}
              >
                {#each sankeyCurrencies as currency}
                  <option value={currency}>{currency}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if detailsData.sankeyLatestExchangeRateDate}
            <span class="chip">
              {$t.overview.exchangeRatesThrough(detailsData.sankeyLatestExchangeRateDate)}
            </span>
          {/if}
        </div>
        <div class="card pad overview-sankey-panel">
          <OverviewSankeyCard
            graph={sankey}
            currency={sankeyCurrency}
            exchangeRates={detailsData.sankeyExchangeRates}
          />
        </div>
        </section>
      {/if}
    </ProgressiveBlock>
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

  .sankey-card {
    margin-top: var(--space-4);
  }

  .projection-state {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--muted);
    background: var(--surface-soft);
  }

  .history-state {
    min-height: 5rem;
    align-items: center;
  }

  .projection-gap-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text);
    font-size: var(--font-size-sm);
  }

</style>
