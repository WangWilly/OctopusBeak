<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import { createBalanceChartZoom } from "$lib/shared-accounts/balance-chart-zoom.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildStackedYAxis, buildTrendYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { formatSnapshotAxisLabel } from "$lib/overview/components/snapshot-chart-data.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { formatUtcDate } from "$lib/time/timezone.ts";
  import { NO_PROVENANCE } from "$lib/shared-ledger/provenance.ts";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { institutionLogo } from "$lib/institutions/institutions.ts";
  import { accountShortLabel } from "$lib/shared-accounts/localize-account.ts";
  import {
    selectStackedBalanceChartSeries,
    stackedBalanceChartState,
    type StackedBalanceChartData,
    type StackedBalanceSeries,
  } from "./stacked-balance-chart-data.ts";

  export let chart: StackedBalanceChartData = { dates: [], series: [], totals: [], signature: "", provenance: NO_PROVENANCE };
  export let currency = "TWD";
  export let label = "";

  let selectedSeriesKeys: string[] = [];
  const zoom = createBalanceChartZoom({ click: "reset" });
  let lastSignature = "";
  type PlotPoint = StackedBalanceChartData["totals"][number] & { position: string };

  $: if (chart.signature !== lastSignature) {
    selectedSeriesKeys = [];
    lastSignature = chart.signature;
    zoom.reset();
  }
  $: chartState = stackedBalanceChartState(chart);
  $: visibleChart = selectStackedBalanceChartSeries(chart, selectedSeriesKeys);
  $: isSingleSeriesSelected = selectedSeriesKeys.length === 1;
  $: selectedKeySet = new Set(selectedSeriesKeys);
  $: axisTimes = visibleChart.totals.map((point) => point.time);
  $: xValues = axisTimes.map((_, index) => String(index));
  $: positionByTime = new Map(axisTimes.map((time, index) => [time, String(index)]));
  $: plottedTotals = visibleChart.totals.map((point) => ({ ...point, position: positionByTime.get(point.time)! }));
  $: plottedSeries = visibleChart.series.map((series) => ({
    ...series,
    data: series.data.map((point) => ({ ...point, position: positionByTime.get(point.time)! })),
  }));
  $: xDomain = xValues;
  $: yAxis = isSingleSeriesSelected
    ? buildTrendYAxis(visibleChart.totals.map((point) => point.value))
    : buildStackedYAxis(visibleChart.totals.map((point) => point.value));
  $: yDomain = isSingleSeriesSelected ? [yAxis.min, yAxis.max] : [0, yAxis.max];
  $: displayLabel = label || $t.common.balance;
  $: kindLabels = {
    bank: $t.accounts.bank,
    fund: $t.accounts.fund,
    brokerage: $t.accounts.brokerage,
    crypto: $t.accounts.crypto,
    foreign: $t.accounts.foreign,
    "credit-card": $t.accounts.creditCard,
    loan: $t.accounts.loan,
    manual: $t.accounts.manual,
    other: $t.accounts.other,
  } as Record<string, string>;
  $: ariaLabel = $t.chart.labelAria(displayLabel, currency);

  function toggleSeries(key: string) {
    selectedSeriesKeys = selectedKeySet.has(key)
      ? selectedSeriesKeys.filter((item) => item !== key)
      : [...selectedSeriesKeys, key];
    zoom.reset();
  }

  function shortDate(value: unknown) {
    if (typeof value !== "string") return String(value ?? "");
    const index = Number(value);
    const time = axisTimes[index];
    return typeof time === "number" ? formatSnapshotAxisLabel(time, $systemTimezone, $locale) : "";
  }

  function tooltipDate(value: unknown) {
    if (typeof value !== "number") return String(value ?? "");
    return formatUtcDate(new Date(value).toISOString(), $systemTimezone, $locale);
  }

  function shortAmount(value: unknown) {
    return typeof value === "number" ? formatSparklineTick(value, yAxis.step) : String(value);
  }

  function tooltipValue(series: StackedBalanceChartData["series"][number], data: { time?: unknown } | null | undefined) {
    if (typeof data?.time !== "number") return 0;
    return series.data.find((point) => point.time === data.time)?.value ?? 0;
  }

  function tooltipTotal(data: { time?: unknown } | null | undefined) {
    if (typeof data?.time !== "number") return 0;
    return visibleChart.totals.find((point) => point.time === data.time)?.value ?? 0;
  }

  function orderedTooltipSeries() {
    return [...visibleChart.series].reverse();
  }
</script>

<!-- A series of one account: as in the Overview breakdown, the logo names the Institution and a screen reader hears the full name. -->
{#snippet seriesName(item: { key: string; label: string; account: StackedBalanceSeries["account"] }, size: number)}
  {#if item.account && institutionLogo(item.account.institutionKey)}
    <InstitutionLogo institution={institutionLogo(item.account.institutionKey)} {size} />
    <span class="visually-hidden">{item.label}</span>
    <span class="series-short" aria-hidden="true">{accountShortLabel(item.account, $t)}</span>
  {:else}
    {kindLabels[item.key] ?? item.label}
  {/if}
{/snippet}

{#if chartState === "trend"}
  <div class="stacked-balance-chart">
    <div class="stacked-balance-controls">
      {#if $zoom.range}
        <button class="stacked-balance-range-button" type="button" onclick={zoom.reset}>
          {$t.spending.chartReset}
        </button>
      {/if}
    </div>
    <div class="stacked-balance-stage" role="img" aria-label={ariaLabel}>
      {#key $zoom.resetKey}
      <AreaChart
        data={plottedTotals}
        flatData={plottedTotals}
        x="position"
        y="value"
        transform={{ mode: "domain", axis: "x" }}
        brush={zoom.brush}
        series={plottedSeries}
        seriesLayout="stack"
        {xDomain}
        yDomain={$zoom.range ?? yDomain}
        yBaseline={isSingleSeriesSelected ? null : 0}
        yNice={false}
        axis={true}
        grid={{ y: true }}
        legend={false}
        tooltipContext={{ mode: "band" }}
        motion={{ type: "tween", duration: 180 }}
        padding={{ top: 12, right: 14, bottom: 28, left: 56 }}
        height={260}
        props={{
          area: { class: "stacked-balance-area" },
          line: { class: "stacked-balance-line" },
          xAxis: { class: "sparkline-axis", format: shortDate, tickSpacing: 80 },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            tickLabelProps: { "data-sensitive": "" },
          },
          grid: { class: "sparkline-grid" },
        }}
      >
        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              <div class="sparkline-tooltip-body stacked-balance-tooltip">
                <span>{tooltipDate(data?.time)}</span>
                <div class="stacked-balance-tooltip-row stacked-balance-tooltip-total">
                  <span>{$t.chart.total}</span>
                  <strong data-sensitive>{formatMoney({ currency, value: tooltipTotal(data) }, { locale: $locale })}</strong>
                </div>
                {#each orderedTooltipSeries() as item}
                  <div class="stacked-balance-tooltip-row">
                    <span class="stacked-balance-tooltip-label">
                      <span class="stacked-balance-tooltip-swatch" style:background-color={item.color}></span>
                      {@render seriesName(item, 14)}
                    </span>
                    <strong data-sensitive>{formatMoney({ currency, value: tooltipValue(item, data) }, { locale: $locale })}</strong>
                  </div>
                {/each}
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </AreaChart>
      {/key}
    </div>
    <div class="stacked-balance-legend" aria-label={$t.chart.legendAria(displayLabel)}>
      {#each chart.series as series}
        <button
          class:selected={selectedSeriesKeys.length === 0 || selectedKeySet.has(series.key)}
          class="stacked-balance-legend-item"
          type="button"
          title={kindLabels[series.key] ?? series.label}
          aria-pressed={selectedSeriesKeys.length === 0 || selectedKeySet.has(series.key)}
          onclick={() => toggleSeries(series.key)}
        >
          <span class="stacked-balance-legend-swatch" style:background-color={series.color}></span>
          <span class="stacked-balance-legend-label">{@render seriesName(series, 12)}</span>
        </button>
      {/each}
    </div>
  </div>
{:else if chartState === "single-day"}
  <div class="sparkline-empty compact" role="img" aria-label={ariaLabel}>
    {$t.chart.singleDay(chart.totals[0]?.dateLabel ?? "")}
  </div>
{:else}
  <div class="sparkline-empty compact" role="img" aria-label={ariaLabel}>
    {$t.chart.noHistory(currency)}
  </div>
{/if}

<style>
  .stacked-balance-chart :global(.lc-layout-svg) {
    overflow: hidden;
  }

  .stacked-balance-chart {
    min-height: 286px;
  }

  .stacked-balance-stage {
    height: 260px;
  }

  .stacked-balance-controls {
    display: flex;
    justify-content: flex-end;
    min-height: 24px;
    padding: 0 14px;
  }

  .stacked-balance-range-button {
    min-height: 24px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    font-weight: 700;
  }

  .stacked-balance-range-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .stacked-balance-tooltip {
    min-width: 180px;
  }

  .stacked-balance-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .stacked-balance-tooltip-total {
    margin-bottom: 4px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }

  .stacked-balance-tooltip-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .stacked-balance-tooltip-swatch {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    flex: 0 0 auto;
  }

  :global(.stacked-balance-area) {
    opacity: 0.34;
  }

  :global(.stacked-balance-line) {
    stroke-width: 2;
  }

  .stacked-balance-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    justify-content: center;
    max-width: 100%;
    padding: 6px 24px 0;
    overflow: hidden;
  }

  .stacked-balance-legend-item {
    min-width: 0;
    max-width: 180px;
    min-height: 20px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    opacity: 0.38;
  }

  .stacked-balance-legend-item.selected {
    opacity: 1;
  }

  .stacked-balance-legend-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .stacked-balance-legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex: 0 0 auto;
  }

  .stacked-balance-legend-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stacked-balance-legend-label :global(.institution-logo) {
    margin-right: 4px;
    vertical-align: -2px;
  }
</style>
