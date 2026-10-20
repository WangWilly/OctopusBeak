<script lang="ts">
  import { ChartLine } from "@lucide/svelte";

  import { readAssetsSummary, type AssetsSummary } from "$lib/assets/assets-summary.ts";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { ASSET_CATEGORY_COLOR, formatShare, formatShortDate, formatTwd, formatTwdNumber } from "$lib/overview/overview-format.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import PageTotalCard from "$lib/shared-accounts/components/PageTotalCard.svelte";
  import ProjectionStateBanner from "$lib/shared-accounts/components/ProjectionStateBanner.svelte";
  import SummaryTile from "$lib/shared-accounts/components/SummaryTile.svelte";
  import { awaitingFirstData } from "$lib/shared-ledger/first-data.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import { currencyCount } from "$lib/shared-money/money.ts";
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import { localizeAccounts } from "$lib/shared-accounts/localize-account.ts";
  import {
    buildStackedBalanceChartData,
    chartCurrenciesFor,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptyPanel from "$lib/shared-shell/components/EmptyPanel.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
  import PreviewMarker from "$lib/shared-shell/components/PreviewMarker.svelte";

  export let assets: AssetsPageDto;
  export let focusAccountId: string | null = null;

  const EMPTY_TILE_CATEGORIES = ["brokerage", "crypto", "bank", "fund", "foreign"] as const;
  const EMPTY_TILE_COLOR = "color-mix(in oklch, var(--muted) 45%, transparent)";

  let search = "";
  let chartCurrency = "TWD";
  let accountFilter: BalanceChartFilter = "all";




  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: stackedChart = buildStackedBalanceChartData({
    accounts: localizeAccounts(assets.accounts, $t),
    dailyHistoryByAccount: assets.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "asset",
  });
  $: summary = readAssetsSummary(assets, { today });
  $: assetAccounts = assets.accounts;
  $: isEmpty = awaitingFirstData(assets);
  $: holdsForeign = assetAccounts.some((account) => account.amountLines.some((amount) => amount.currency !== "TWD"));
  $: sideValue = isEmpty ? "—" : summary.state === "ready" ? formatTwd(summary.total, $locale) : "--";
  $: sideSub = isEmpty ? $t.assets.empty.side : $t.assets.sideSub(
    assetAccounts.length,
    currencyCount(assetAccounts.map((account) => account.amountLines)),
  );
  $: chartCurrencies = chartCurrenciesFor(assets.dailyHistory, "assets");
  $: if (!chartCurrencies.includes(chartCurrency)) chartCurrency = chartCurrencies[0] ?? "TWD";

  function totalLabel(current: AssetsSummary) {
    return current.state === "ready" && holdsForeign && current.slices.length > 0
      ? `${$t.assets.total} · ${$t.overview.allocationRateDate(formatShortDate(current.valuationDate, $locale))}`
      : $t.assets.total;
  }


  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

</script>

<DashboardShell
  active="assets"
  eyebrow={$t.assets.eyebrow}
  title={$t.assets.title}
  sideLabel={$t.assets.sideLabel}
  {sideValue}
  {sideSub}
  sideIncludesPreview={!isEmpty && summary.state === "ready" && summary.includesPreview}
  searchPlaceholder={$t.assets.searchPlaceholder}
  bind:search
>
  <div class="content">
    {#if isEmpty}
      <div class="empty-banner">
        <EmptySourceBanner title={$t.assets.empty.bannerTitle} body={$t.assets.empty.bannerBody} />
      </div>
    {:else}
      <ProjectionStateBanner projection={assets} />
    {/if}
    <div class="block-frame">
      <PageTotalCard
        label={totalLabel(summary)}
        ariaLabel={$t.assets.metricsAria}
        total={summary.state === "ready" ? summary.total : null}
        trailing={summary.state === "ready" ? summary.trailing : null}
        includesPreview={summary.state === "ready" && summary.includesPreview}
        notes={isEmpty
          ? [$t.assets.empty.totalNote]
          : summary.state === "ready" && summary.unconvertedCurrencies.length > 0
            ? [$t.overview.unconverted(summary.unconvertedCurrencies.join(", "))]
            : []}
      >
        {#if isEmpty}
          {#each EMPTY_TILE_CATEGORIES as category}
            <SummaryTile color={EMPTY_TILE_COLOR} head={$t.overview.assetCategories[category]} value="—" sub="–" share={0} />
          {/each}
        {:else if summary.state === "ready"}
          {#each summary.slices as slice (slice.category)}
            <SummaryTile
              color={ASSET_CATEGORY_COLOR[slice.category]}
              head={$t.overview.assetCategories[slice.category]}
              value={formatShare(slice.share, $locale)}
              sub={formatTwdNumber(slice.value, $locale)}
              subSensitive
              share={slice.share}
            />
          {/each}
        {/if}
      </PageTotalCard>
    </div>

    <div class="block-frame">
      <section class="card balance-history" aria-label={$t.assets.balanceHistoryAria}>
      <div class="panel-title">
        <h2>{$t.assets.assetBalance}</h2>
        {#if chartCurrencies.length > 0}
          <label class="chip select-chip" for="asset-balance-currency">
            <select
              id="asset-balance-currency"
              aria-label={$t.assets.assetBalanceCurrency}
              bind:value={chartCurrency}
              onchange={(event) => (chartCurrency = selectValue(event))}
              oninput={(event) => (chartCurrency = selectValue(event))}
            >
              {#each chartCurrencies as option}
                <option>{option}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if stackedChart.series.length > 0}
          <span class="chip">{$t.common.days30}</span>
        {/if}
        {#if stackedChart.includesPreview}<PreviewMarker align="end" />{/if}
      </div>
      <div class="pad balance-chart">
        {#if isEmpty}
          <EmptyPanel icon={ChartLine} title={$t.assets.empty.chartTitle} body={$t.assets.empty.chartBody} />
        {:else}
          <StackedBalanceChart
            chart={stackedChart}
            currency={chartCurrency}
            label={$t.overview.assetAllocation}
          />
        {/if}
      </div>
      </section>
    </div>

    <div class="block-frame">
      <AccountTable
        accounts={assets.accounts}
        coveredAccounts={assets.coveredAccounts}
        mode="asset"
        bind:search
        bind:filter={accountFilter}
        positionsByAccount={assets.positionsByAccount}
        transactionsByAccount={assets.transactionsByAccount}
        dailyHistoryByAccount={assets.dailyHistoryByAccount}
        shares={summary.state === "ready" ? summary.shares : new Map()}
        twdValues={summary.state === "ready" ? summary.twdValues : new Map()}
        focusAccountId={focusAccountId}
      />
    </div>
  </div>
</DashboardShell>

<style>
  .block-frame { position: relative; min-width: 0; }
  .empty-banner {
    margin-bottom: var(--space-6);
  }
</style>
