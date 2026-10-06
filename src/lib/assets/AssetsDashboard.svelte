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
  import { historyPointKey } from "$lib/shared-ledger/types.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import { currencyCount } from "$lib/shared-money/money.ts";
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import { localizeAccounts } from "$lib/shared-accounts/localize-account.ts";
  import {
    buildStackedBalanceChartData,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptyPanel from "$lib/shared-shell/components/EmptyPanel.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type {
    DashboardBlockPayload,
    DashboardBlockValueMap,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import {
    resolveAssetsChart,
    resolveAssetsList,
    resolveAssetsSummary,
  } from "$lib/shared-shell/progressive-dashboard-data.ts";

  export let assets: AssetsPageDto;
  export let focusAccountId: string | null = null;
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};

  const EMPTY_TILE_CATEGORIES = ["brokerage", "crypto", "bank", "fund", "foreign"] as const;
  const EMPTY_TILE_COLOR = "color-mix(in oklch, var(--muted) 45%, transparent)";

  let search = "";
  let chartCurrency = "TWD";
  let accountFilter: BalanceChartFilter = "all";

  function blockState(key: string): BlockState<DashboardBlockPayload> {
    return blocks[key] ?? { status: "loading" };
  }

  function assetsBlockData<Key extends keyof DashboardBlockValueMap["assets"]>(
    key: Key,
    payload: DashboardBlockPayload | undefined,
  ): DashboardBlockValueMap["assets"][Key] | undefined {
    return payload?.route === "assets" && payload.block === key
      ? payload.data as DashboardBlockValueMap["assets"][Key]
      : undefined;
  }

  function settledSummaryBlock(states: typeof blocks) {
    const state = states.summary;
    return assetsBlockData("summary", state && "data" in state ? state.data : undefined);
  }

  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: summary = readAssetsSummary(resolveAssetsSummary(assets, settledSummaryBlock(blocks)), { today });
  $: assetAccounts = assets.accounts;
  $: isEmpty = awaitingFirstData(assets);
  $: holdsForeign = assetAccounts.some((account) => account.amountLines.some((amount) => amount.currency !== "TWD"));
  $: sideValue = isEmpty ? "—" : summary.state === "ready" ? formatTwd(summary.total, $locale) : "--";
  $: sideSub = isEmpty ? $t.assets.empty.side : $t.assets.sideSub(
    assetAccounts.length,
    currencyCount(assetAccounts.map((account) => account.amountLines)),
  );
  $: chartRows = [...assets.dailyHistory].sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right))).slice(-30);
  $: chartCurrencies = [
    ...new Set(chartRows.flatMap((row) => row.assets.map((amount) => amount.currency))),
  ].sort((left, right) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right));
  $: if (!chartCurrencies.includes(chartCurrency)) chartCurrency = chartCurrencies[0] ?? "TWD";
  $: chartData = buildStackedBalanceChartData({
    accounts: assetAccounts,
    dailyHistoryByAccount: assets.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "asset",
  });

  function totalLabel(current: AssetsSummary) {
    return current.state === "ready" && holdsForeign && current.slices.length > 0
      ? `${$t.assets.total} · ${$t.overview.allocationRateDate(formatShortDate(current.valuationDate, $locale))}`
      : $t.assets.total;
  }

  function currencyOrder(value: string) {
    return value === "TWD" ? 0 : value === "USD" ? 1 : value === "JPY" ? 2 : 3;
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
    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")}>
      <PageTotalCard
        label={totalLabel(summary)}
        ariaLabel={$t.assets.metricsAria}
        total={summary.state === "ready" ? summary.total : null}
        trailing={summary.state === "ready" ? summary.trailing : null}
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
    </ProgressiveBlock>

    <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")} let:data>
      {@const chartBlock = assetsBlockData("chart", data)}
      {@const chartDataBlock = resolveAssetsChart(assets, chartBlock)}
      {@const stackedChart = chartBlock ? buildStackedBalanceChartData({
        accounts: localizeAccounts(chartDataBlock.accounts, $t),
        dailyHistoryByAccount: chartDataBlock.dailyHistoryByAccount,
        filter: accountFilter,
        currency: chartCurrency,
        mode: "asset",
      }) : chartData}
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
    </ProgressiveBlock>

    <ProgressiveBlock label="list" state={blockState("list")} retry={() => retryBlock("list")} let:data>
      {@const listBlock = assetsBlockData("list", data)}
      {@const listDataBlock = resolveAssetsList(assets, listBlock)}
      <AccountTable
        accounts={listDataBlock.accounts}
        mode="asset"
        bind:search
        bind:filter={accountFilter}
        positionsByAccount={listDataBlock.positionsByAccount}
        transactionsByAccount={listDataBlock.transactionsByAccount}
        dailyHistoryByAccount={listDataBlock.dailyHistoryByAccount}
        shares={summary.state === "ready" ? summary.shares : new Map()}
        twdValues={summary.state === "ready" ? summary.twdValues : new Map()}
        focusAccountId={focusAccountId}
      />
    </ProgressiveBlock>
  </div>
</DashboardShell>

<style>
  .empty-banner {
    margin-bottom: var(--space-6);
  }
</style>
