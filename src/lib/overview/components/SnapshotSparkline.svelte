<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import {
    buildSnapshotChartPoints,
    buildSnapshotDivergingSeries,
    selectSnapshotDivergingSeries,
    type SnapshotChartPoint,
    type SnapshotDivergingSeries,
    type SnapshotDivergingSeriesKey,
  } from "./snapshot-chart-data.ts";
  import { buildCenteredSparklineYAxis, buildSparklineYAxis, formatSparklineTick } from "./sparkline-format.ts";

  type HistoryAmountKey = "netAssets" | "assets" | "liabilities";

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";
  export let amountKey: HistoryAmountKey = "netAssets";
  export let label = "Net position";
  export let diverging = false;

  let selectedSeriesKeys: SnapshotDivergingSeriesKey[] = [];

  $: points = buildSnapshotChartPoints(rows, currency, amountKey);
  $: divergingSeries = diverging ? buildSnapshotDivergingSeries(rows, currency) : [];
  $: visibleDivergingSeries = selectSnapshotDivergingSeries(divergingSeries, selectedSeriesKeys);
  $: selectedSeriesKeySet = new Set(selectedSeriesKeys);
  $: chartPoints = diverging ? visibleDivergingSeries.flatMap((series) => series.data) : points;
  $: xValues = [...new Set(chartPoints.map((point) => point.time))].sort((left, right) => left - right);
  $: xDomain = xValues.length > 1 ? [xValues[0], xValues[xValues.length - 1]] : xValues;
  $: timelinePoints = xValues.map((time) => timelinePoint(time, chartPoints));
  $: yAxis = diverging
    ? buildCenteredSparklineYAxis(chartPoints.map((point) => point.value))
    : buildSparklineYAxis(chartPoints.map((point) => point.value));
  $: yDomain = [yAxis.min, yAxis.max];
  $: ariaLabel = `${label} trend ${currency}`;
  $: hasChartData = diverging ? divergingSeries.length > 0 : points.length > 0;

  function toggleSeries(key: SnapshotDivergingSeriesKey) {
    if (selectedSeriesKeys.length === 0) {
      selectedSeriesKeys = [key];
      return;
    }
    if (selectedSeriesKeySet.has(key)) {
      selectedSeriesKeys = selectedSeriesKeys.filter((item) => item !== key);
      return;
    }
    selectedSeriesKeys = [...selectedSeriesKeys, key];
  }

  function shortDate(value: unknown) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return monthDay(value);
    if (typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return monthDay(date);
    }
    const text = String(value);
    return text.length >= 10 ? text.slice(5, 10) : text;
  }

  function monthDay(value: Date) {
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${month}-${day}`;
  }

  function shortAmount(value: unknown) {
    return typeof value === "number" ? formatSparklineTick(value, yAxis.step) : String(value);
  }

  function tooltipValue(series: SnapshotDivergingSeries, data: { time?: unknown } | null | undefined) {
    if (typeof data?.time !== "number") return 0;
    return series.data.find((point) => point.time === data.time)?.value ?? 0;
  }

  function timelinePoint(time: number, data: SnapshotChartPoint[]): SnapshotChartPoint {
    const existing = data.find((point) => point.time === time);
    if (existing) return existing;
    const date = new Date(time).toISOString().slice(0, 10);
    return { date, dateLabel: date, time, value: 0 };
  }
</script>

{#if hasChartData}
  {#if diverging}
    <div class="sparkline sparkline-diverging" role="img" aria-label={ariaLabel}>
      <div class="snapshot-diverging-stage">
        <AreaChart
          data={timelinePoints}
          flatData={timelinePoints}
          x="time"
          y="value"
          series={visibleDivergingSeries}
          seriesLayout="overlap"
          {xDomain}
          {yDomain}
          yBaseline={null}
          yNice={false}
          axis={true}
          grid={{ y: true }}
          legend={false}
          tooltipContext={{ mode: "bisect-x", findTooltipData: "closest" }}
          motion={{ type: "tween", duration: 180 }}
          padding={{ top: 12, right: 12, bottom: 24, left: 56 }}
          points={false}
          height={220}
          props={{
            area: { class: "snapshot-diverging-area" },
            line: { class: "snapshot-diverging-line" },
            xAxis: { class: "sparkline-axis", format: shortDate, ticks: xValues },
            yAxis: {
              class: "sparkline-axis",
              format: shortAmount,
              ticks: yAxis.ticks,
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
      <div class="snapshot-diverging-legend" aria-label={`${label} legend`}>
        {#each divergingSeries as series}
          <button
            class:selected={selectedSeriesKeys.length === 0 || selectedSeriesKeySet.has(series.key)}
            class="snapshot-diverging-legend-item"
            type="button"
            title={series.label}
            aria-pressed={selectedSeriesKeys.length === 0 || selectedSeriesKeySet.has(series.key)}
            on:click={() => toggleSeries(series.key)}
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
        data={points}
        x="time"
        y="value"
        {xDomain}
        {yDomain}
        yBaseline={null}
        yNice
        axis={true}
        grid={{ y: true }}
        tooltipContext={{ mode: "bisect-x", findTooltipData: "closest" }}
        padding={{ top: 12, right: 12, bottom: 24, left: 48 }}
        points={points.length === 1 ? { r: 5, class: "sparkline-dot" } : false}
        height={220}
        props={{
          area: { class: "sparkline-area" },
          line: { class: "sparkline-line" },
          xAxis: { class: "sparkline-axis", format: shortDate, ticks: xValues },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            ticks: yAxis.ticks,
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
{:else}
  <div class="sparkline sparkline-empty" role="img" aria-label={ariaLabel}>
    No {currency} history
  </div>
{/if}

<style>
  .sparkline-diverging {
    height: 260px;
  }

  .snapshot-diverging-stage {
    height: 220px;
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
