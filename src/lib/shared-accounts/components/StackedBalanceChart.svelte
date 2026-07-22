<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildSparklineYAxis, buildTrendYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
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
  let brushedYDomain: [number, number] | null = null;
  let lastSignature = "";
  let hasYRange = false;
  let yRangeReset = 0;
  type PlotPoint = StackedBalanceChartData["totals"][number] & { position: string };

  $: if (chart.signature !== lastSignature) {
    selectedSeriesKeys = [];
    lastSignature = chart.signature;
    resetYRange();
  }
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
    : buildSparklineYAxis([0, ...visibleChart.totals.map((point) => point.value)]);
  $: yDomain = isSingleSeriesSelected ? [yAxis.min, yAxis.max] : [0, yAxis.max];
  $: displayLabel = label || $t.common.balance;
  $: ariaLabel = $t.chart.labelAria(displayLabel, currency);

  function toggleSeries(key: string) {
    if (selectedSeriesKeys.length === 0) {
      selectedSeriesKeys = [key];
      resetYRange();
      return;
    }
    if (selectedKeySet.has(key)) {
      selectedSeriesKeys = selectedSeriesKeys.filter((item) => item !== key);
      resetYRange();
      return;
    }
    selectedSeriesKeys = [...selectedSeriesKeys, key];
    resetYRange();
  }

  function trackYRange({ brush }: { brush: { active?: boolean; y: Array<number | Date | string | null> } }) {
    const [start, end] = brush.y;
    if (brush.active && typeof start === "number" && typeof end === "number") {
      brushedYDomain = [Math.min(start, end), Math.max(start, end)];
      hasYRange = true;
      return;
    }
    brushedYDomain = null;
    hasYRange = false;
  }

  function resetYRange() {
    brushedYDomain = null;
    hasYRange = false;
    yRangeReset += 1;
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
    return typeof value === "number" ? formatSparklineTick(value) : String(value);
  }

  function tooltipValue(series: StackedBalanceChartData["series"][number], data: { time?: unknown } | null | undefined) {
    if (typeof data?.time !== "number") return 0;
    return series.data.find((point) => point.time === data.time)?.value ?? 0;
  }

  function orderedTooltipSeries() {
    return [...visibleChart.series].reverse();
  }
</script>

{#if chart.series.length > 0}
  <div class="stacked-balance-chart">
    <div class="stacked-balance-controls">
      {#if hasYRange}
        <button class="stacked-balance-range-button" type="button" onclick={resetYRange}>
          {$t.spending.chartReset}
        </button>
      {/if}
    </div>
    <div class="stacked-balance-stage" role="img" aria-label={ariaLabel}>
      {#key `${chart.signature}:${selectedSeriesKeys.join(",")}:${yRangeReset}`}
      <AreaChart
        data={plottedTotals}
        flatData={plottedTotals}
        x="position"
        y="value"
        transform={{ mode: "domain", axis: "x" }}
        brush={{ axis: "y", clickToReset: true, onBrushEnd: trackYRange }}
        series={plottedSeries}
        seriesLayout="stack"
        {xDomain}
        yDomain={brushedYDomain ?? yDomain}
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
                {#each orderedTooltipSeries() as item}
                  <div class="stacked-balance-tooltip-row">
                    <span class="stacked-balance-tooltip-label">
                      <span class="stacked-balance-tooltip-swatch" style:background-color={item.color}></span>
                      {item.label}
                    </span>
                    <strong data-sensitive>{formatMoney({ currency, value: tooltipValue(item, data) })}</strong>
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
          title={series.label}
          aria-pressed={selectedSeriesKeys.length === 0 || selectedKeySet.has(series.key)}
          onclick={() => toggleSeries(series.key)}
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
</style>
