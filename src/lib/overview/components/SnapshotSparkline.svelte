<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import {
    buildSnapshotChartPoints,
    buildSnapshotDivergingSeries,
    formatSnapshotAxisLabel,
    selectSnapshotDivergingSeries,
    type SnapshotChartPoint,
    type SnapshotDivergingSeries,
    type SnapshotDivergingSeriesKey,
  } from "./snapshot-chart-data.ts";
  import { buildCenteredSparklineYAxis, buildSparklineYAxis, buildTrendYAxis, formatSparklineTick } from "./sparkline-format.ts";

  type HistoryAmountKey = "netAssets" | "assets" | "liabilities";
  type PlotPoint = SnapshotChartPoint & { position: string };

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";
  export let amountKey: HistoryAmountKey = "netAssets";
  export let label = "";
  export let diverging = false;

  let selectedSeriesKeys: SnapshotDivergingSeriesKey[] = [];
  let hasYRange = false;
  let yRangeReset = 0;
  let lastRows = rows;
  let lastCurrency = currency;
  let lastAmountKey = amountKey;
  let lastDiverging = diverging;

  $: if (rows !== lastRows || currency !== lastCurrency || amountKey !== lastAmountKey || diverging !== lastDiverging) {
    lastRows = rows;
    lastCurrency = currency;
    lastAmountKey = amountKey;
    lastDiverging = diverging;
    resetYRange();
  }
  $: points = buildSnapshotChartPoints(rows, currency, amountKey, $systemTimezone, $locale);
  $: divergingSeries = diverging
    ? buildSnapshotDivergingSeries(rows, currency, $systemTimezone, $locale).map((series) => ({
        ...series,
        label: translateDivergingSeries(series.key, $t),
      }))
    : [];
  $: visibleDivergingSeries = selectSnapshotDivergingSeries(divergingSeries, selectedSeriesKeys);
  $: selectedSeriesKeySet = new Set(selectedSeriesKeys);
  $: chartPoints = diverging ? visibleDivergingSeries.flatMap((series) => series.data) : points;
  $: axisTimes = [...new Set(chartPoints.map((point) => point.time))].sort((left, right) => left - right);
  $: xValues = axisTimes.map((_, index) => String(index));
  $: positionByTime = new Map(axisTimes.map((time, index) => [time, String(index)]));
  $: plottedPoints = points.map((point) => ({ ...point, position: positionByTime.get(point.time)! }));
  $: plottedDivergingSeries = visibleDivergingSeries.map((series) => ({
    ...series,
    data: series.data.map((point) => ({ ...point, position: positionByTime.get(point.time)! })),
  }));
  $: plottedChartPoints = diverging ? plottedDivergingSeries.flatMap((series) => series.data) : plottedPoints;
  $: xDomain = xValues;
  $: timelinePoints = xValues.map((position) => timelinePoint(position, plottedChartPoints));
  $: yAxis = diverging
    ? selectedSeriesKeys.length === 1
      ? buildTrendYAxis(chartPoints.map((point) => point.value))
      : buildCenteredSparklineYAxis(chartPoints.map((point) => point.value))
    : buildSparklineYAxis(chartPoints.map((point) => point.value));
  $: yDomain = [yAxis.min, yAxis.max];
  $: displayLabel = label || $t.overview.sideLabel;
  $: ariaLabel = $t.chart.trendAria(displayLabel, currency);
  $: hasChartData = diverging ? divergingSeries.length > 0 : points.length > 0;

  function toggleSeries(key: SnapshotDivergingSeriesKey) {
    if (selectedSeriesKeys.length === 0) {
      selectedSeriesKeys = [key];
      resetYRange();
      return;
    }
    if (selectedSeriesKeySet.has(key)) {
      selectedSeriesKeys = selectedSeriesKeys.filter((item) => item !== key);
      resetYRange();
      return;
    }
    selectedSeriesKeys = [...selectedSeriesKeys, key];
    resetYRange();
  }

  function trackYRange({ brush }: { brush: { active?: boolean } }) {
    hasYRange = Boolean(brush.active);
  }

  function resetYRange() {
    hasYRange = false;
    yRangeReset += 1;
  }

  function shortDate(value: unknown) {
    if (typeof value !== "string") return String(value ?? "");
    const index = Number(value);
    const time = axisTimes[index];
    return typeof time === "number"
      ? formatSnapshotAxisLabel(time, $systemTimezone, $locale, chartPoints)
      : "";
  }

  function shortAmount(value: unknown, step = yAxis.step) {
    return typeof value === "number" ? formatSparklineTick(value, step) : String(value);
  }

  function tooltipValue(series: SnapshotDivergingSeries, data: { time?: unknown } | null | undefined) {
    if (typeof data?.time !== "number") return 0;
    return series.data.find((point) => point.time === data.time)?.value ?? 0;
  }

  function timelinePoint(position: string, data: PlotPoint[]): PlotPoint {
    const existing = data.find((point) => point.position === position);
    if (existing) return existing;
    const time = axisTimes[Number(position)] ?? 0;
    const date = new Date(time).toISOString().slice(0, 10);
    return {
      date,
      dateLabel: date,
      axisLabel: formatSnapshotAxisLabel(time, $systemTimezone, $locale, chartPoints),
      position,
      time,
      value: 0,
    };
  }

  function translateDivergingSeries(key: SnapshotDivergingSeriesKey, dictionary: Translation) {
    if (key === "net") return dictionary.chart.seriesNet;
    if (key === "assets") return dictionary.chart.seriesAssets;
    return dictionary.chart.seriesLiabilities;
  }
</script>

{#if hasChartData}
  <div class="sparkline-container">
    {#if hasYRange}
      <div class="sparkline-controls">
        <button class="sparkline-range-button" type="button" onclick={resetYRange}>{$t.spending.chartReset}</button>
      </div>
    {/if}
    {#key yRangeReset}
    {#if diverging}
      <div class="sparkline sparkline-diverging" role="img" aria-label={ariaLabel}>
      <div class="snapshot-diverging-stage">
          <AreaChart
            data={timelinePoints}
            flatData={timelinePoints}
            x="position"
            y="value"
            brush={{ axis: "y", zoomOnBrush: true, clickToReset: true, onBrushEnd: trackYRange }}
            series={plottedDivergingSeries}
            seriesLayout="overlap"
            {xDomain}
            {yDomain}
            yBaseline={null}
            yNice={false}
            axis={true}
            grid={{ y: true }}
            legend={false}
            tooltipContext={{ mode: "band" }}
            motion={{ type: "tween", duration: 180 }}
            padding={{ top: 12, right: 12, bottom: 24, left: 56 }}
            points={false}
            height={220}
            props={{
              area: { class: "snapshot-diverging-area" },
              line: { class: "snapshot-diverging-line" },
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
                  <div class="sparkline-tooltip-body snapshot-diverging-tooltip">
                    <span>{data?.dateLabel ?? data?.date ?? ""}</span>
                    {#each visibleDivergingSeries as series}
                      <div class="snapshot-diverging-tooltip-row">
                        <span>{series.label}</span>
                        <strong data-sensitive>{formatMoney({ currency, value: tooltipValue(series, data) })}</strong>
                      </div>
                    {/each}
                  </div>
                {/snippet}
              </Tooltip.Root>
            {/snippet}
          </AreaChart>
      </div>
      <div class="snapshot-diverging-legend" aria-label={$t.chart.legendAria(displayLabel)}>
        {#each divergingSeries as series}
          <button
            class:selected={selectedSeriesKeys.length === 0 || selectedSeriesKeySet.has(series.key)}
            class="snapshot-diverging-legend-item"
            type="button"
            title={series.label}
            aria-pressed={selectedSeriesKeys.length === 0 || selectedSeriesKeySet.has(series.key)}
            onclick={() => toggleSeries(series.key)}
          >
            <span class="snapshot-diverging-legend-swatch" style:background-color={series.color}></span>
            <span class="snapshot-diverging-legend-label">{series.label}</span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="sparkline" role="img" aria-label={ariaLabel}>
      <AreaChart
        data={plottedPoints}
        x="position"
        y="value"
        brush={{ axis: "y", zoomOnBrush: true, clickToReset: true, onBrushEnd: trackYRange }}
        {xDomain}
        {yDomain}
        yBaseline={null}
        yNice
        axis={true}
        grid={{ y: true }}
        tooltipContext={{ mode: "band" }}
        padding={{ top: 12, right: 12, bottom: 24, left: 48 }}
        points={points.length === 1 ? { r: 5, class: "sparkline-dot" } : false}
        height={220}
        props={{
          area: { class: "sparkline-area" },
          line: { class: "sparkline-line" },
          xAxis: { class: "sparkline-axis", format: shortDate, tickSpacing: 80 },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            tickLabelProps: { "data-sensitive": "" },
          },
          grid: { class: "sparkline-grid" },
          highlight: { points: { r: 5, class: "sparkline-dot" } },
        }}
      >
        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              <div class="sparkline-tooltip-body">
                <span>{data.dateLabel}</span>
                <strong data-sensitive>{formatMoney({ currency, value: data.value })}</strong>
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </AreaChart>
    </div>
  {/if}
    {/key}
  </div>
{:else}
  <div class="sparkline sparkline-empty" role="img" aria-label={ariaLabel}>
    No {currency} history
  </div>
{/if}

<style>
  .sparkline-container {
    position: relative;
  }

  .sparkline-controls {
    position: absolute;
    top: 0;
    right: 12px;
    z-index: 1;
  }

  .sparkline-range-button {
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

  .sparkline-range-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sparkline-diverging {
    height: 260px;
  }

  .snapshot-diverging-stage {
    height: 220px;
  }

  .sparkline :global(.lc-layout-svg) {
    overflow: hidden;
  }

  :global(.snapshot-diverging-area) {
    fill-opacity: 0;
    opacity: 0;
  }

  :global(.snapshot-diverging-line) {
    fill: none;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .snapshot-diverging-tooltip {
    min-width: 184px;
  }

  .snapshot-diverging-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .snapshot-diverging-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    justify-content: center;
    max-width: 100%;
    padding: 6px 24px 0;
    overflow: hidden;
  }

  .snapshot-diverging-legend-item {
    min-width: 0;
    max-width: 160px;
    min-height: 20px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    opacity: 0.38;
  }

  .snapshot-diverging-legend-item.selected {
    opacity: 1;
  }

  .snapshot-diverging-legend-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .snapshot-diverging-legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex: 0 0 auto;
  }

  .snapshot-diverging-legend-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
