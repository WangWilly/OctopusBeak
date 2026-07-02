<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { buildSnapshotChartPoints } from "./snapshot-chart-data.ts";
  import { buildSparklineYAxis, formatSparklineTick } from "./sparkline-format.ts";

  type HistoryAmountKey = "netAssets" | "assets" | "liabilities";

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";
  export let amountKey: HistoryAmountKey = "netAssets";
  export let label = "Net position";

  $: points = buildSnapshotChartPoints(rows, currency, amountKey);
  $: xDomain = points.map((point) => point.date);
  $: yAxis = buildSparklineYAxis(points.map((point) => point.value));
  $: yDomain = [yAxis.min, yAxis.max];
  $: ariaLabel = `${label} trend ${currency}`;

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
</script>

{#if points.length > 0}
  <div class="sparkline" role="img" aria-label={ariaLabel}>
    <AreaChart
      data={points}
      x="date"
      y="value"
      {xDomain}
      {yDomain}
      yBaseline={null}
      yNice
      axis={true}
      grid={{ y: true }}
      padding={{ top: 12, right: 12, bottom: 24, left: 48 }}
      points={points.length === 1 ? { r: 5, class: "sparkline-dot" } : false}
      height={220}
      props={{
        area: { class: "sparkline-area" },
        line: { class: "sparkline-line" },
        xAxis: { class: "sparkline-axis", format: shortDate },
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
{:else}
  <div class="sparkline sparkline-empty" role="img" aria-label={ariaLabel}>
    No {currency} history
  </div>
{/if}
