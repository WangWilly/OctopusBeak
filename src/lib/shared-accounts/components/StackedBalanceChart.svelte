<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildSparklineYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { formatSnapshotAxisLabel } from "$lib/overview/components/snapshot-chart-data.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { formatUtcDate } from "$lib/time/timezone.ts";
  import {
    selectStackedBalanceChartSeries,
    type StackedBalanceChartData,
  } from "./stacked-balance-chart-data.ts";

  export let chart: StackedBalanceChartData = { dates: [], series: [], totals: [], signature: "" };
  export let currency = "TWD";
  export let label = "";

  let selectedSeriesKeys: string[] = [];
  let lastSignature = "";

  $: if (chart.signature !== lastSignature) {
    selectedSeriesKeys = [];
    lastSignature = chart.signature;
  }
  $: visibleChart = selectStackedBalanceChartSeries(chart, selectedSeriesKeys);
  $: selectedKeySet = new Set(selectedSeriesKeys);
  $: xValues = visibleChart.totals.map((point) => point.time);
  $: xDomain = xValues.length > 1 ? [xValues[0], xValues[xValues.length - 1]] : xValues;
  $: yAxis = buildSparklineYAxis([0, ...visibleChart.totals.map((point) => point.value)]);
  $: yDomain = [0, yAxis.max];
  $: yTicks = yAxis.ticks.filter((tick) => tick >= 0);
  $: displayLabel = label || $t.common.balance;
  $: ariaLabel = $t.chart.labelAria(displayLabel, currency);

  function toggleSeries(key: string) {
    if (selectedSeriesKeys.length === 0) {
      selectedSeriesKeys = [key];
      return;
    }
    if (selectedKeySet.has(key)) {
      selectedSeriesKeys = selectedSeriesKeys.filter((item) => item !== key);
      return;
    }
    selectedSeriesKeys = [...selectedSeriesKeys, key];
  }

  function shortDate(value: unknown) {
    return formatSnapshotAxisLabel(value, $systemTimezone, $locale);
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
</script>

{#if chart.series.length > 0}
  <div class="stacked-balance-chart" role="img" aria-label={ariaLabel}>
    <div class="stacked-balance-stage">
      <AreaChart
        data={visibleChart.totals}
        flatData={visibleChart.totals}
        x="time"
        y="value"
        series={visibleChart.series}
        seriesLayout="stack"
        {xDomain}
        {yDomain}
        yBaseline={0}
        yNice={false}
        axis={true}
        grid={{ y: true }}
        legend={false}
        tooltipContext={{ mode: "bisect-x", findTooltipData: "closest" }}
        motion={{ type: "tween", duration: 180 }}
        padding={{ top: 12, right: 14, bottom: 28, left: 56 }}
        height={260}
        props={{
          area: { class: "stacked-balance-area" },
          line: { class: "stacked-balance-line" },
          xAxis: { class: "sparkline-axis", format: shortDate, ticks: xValues },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            ticks: yTicks,
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
                {#each visibleChart.series as item}
                  <div class="stacked-balance-tooltip-row">
                    <span>{item.label}</span>
                    <strong data-sensitive>{formatMoney({ currency, value: tooltipValue(item, data) })}</strong>
                  </div>
                {/each}
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </AreaChart>
    </div>
    <div class="stacked-balance-legend" aria-label={$t.chart.legendAria(displayLabel)}>
      {#each chart.series as series}
        <button
          class:selected={selectedSeriesKeys.length === 0 || selectedKeySet.has(series.key)}
          class="stacked-balance-legend-item"
          type="button"
          title={series.label}
          aria-pressed={selectedSeriesKeys.length === 0 || selectedKeySet.has(series.key)}
          on:click={() => toggleSeries(series.key)}
        >
          <span class="stacked-balance-legend-swatch" style:background-color={series.color}></span>
          <span class="stacked-balance-legend-label">{series.label}</span>
        </button>
      {/each}
    </div>
  </div>
{:else}
  <div class="stacked-balance-chart sparkline-empty" role="img" aria-label={ariaLabel}>
    {$t.chart.noHistory(currency)}
  </div>
{/if}

<style>
  .stacked-balance-chart {
    min-height: 286px;
  }

  .stacked-balance-stage {
    height: 260px;
  }

  .stacked-balance-tooltip {
    min-width: 180px;
  }

  .stacked-balance-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
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
</style>
