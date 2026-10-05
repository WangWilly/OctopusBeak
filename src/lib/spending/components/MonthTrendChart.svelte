<script lang="ts">
  import { BarChart, Bars, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { TrendMonth } from "../spending-insights.ts";
  import { moneyText, type ExactMoney } from "./money-text.ts";

  type TrendBar = TrendMonth & Readonly<{ tone: "month" | "progress" | "first" | "refund"; tickLow: number | null; tickHigh: number | null }>;

  export let months: readonly TrendMonth[] = [];
  export let selectedMonth: string | null = null;
  export let onSelectMonth: (month: string) => void = () => {};

  $: compactAmount = new Intl.NumberFormat($locale, { notation: "compact", maximumFractionDigits: 1 });
  $: values = months.flatMap((month) => [month.value, month.usualValue ?? 0]).filter(Number.isFinite);
  $: tickHalf = (Math.max(1, ...values) - Math.min(0, ...values)) * 0.008;
  $: bars = months.map((month): TrendBar => ({
    ...month,
    tone: month.value < 0
      ? "refund"
      : month.status === "in-progress"
        ? "progress"
        : month.status === "first-imported" ? "first" : "month",
    tickLow: month.usualValue === null ? null : month.usualValue - tickHalf,
    tickHigh: month.usualValue === null ? null : month.usualValue + tickHalf,
  }));
  $: plotted = bars.filter((month) => month.status !== "before-history" && month.value !== 0);
  $: selected = plotted.filter((month) => month.month === selectedMonth);
  $: ticks = bars.filter((month) => month.tickLow !== null);
  $: inProgress = months.find((month) => month.status === "in-progress") ?? null;
  $: hasUsual = ticks.length > 0;
  $: labelled = new Set<string>(months
    .filter((month, index) => (months.length - 1 - index) % 2 === 0 || month.month === selectedMonth)
    .map((month) => month.month));

  function amountText(amount: ExactMoney) {
    return moneyText(amount, $locale);
  }

  function monthDate(month: string) {
    return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  }

  function shortMonth(month: string) {
    return new Intl.DateTimeFormat($locale, { month: "short", timeZone: "UTC" }).format(monthDate(month));
  }

  function longMonth(month: string) {
    return new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(monthDate(month));
  }

  function monthTick(value: unknown) {
    return typeof value === "string" && labelled.has(value) ? shortMonth(value) : "";
  }

  function selectBar(_event: MouseEvent, detail: { data: TrendBar }) {
    if (detail.data.selectable) onSelectMonth(detail.data.month);
  }
</script>

<div class="month-trend" data-trend-chart data-selected-month={selectedMonth ?? ""}>
  <div class="trend-plot" role="img" aria-label={$t.spendingInsight.trendAria}>
    <BarChart
      data={bars}
      x="month"
      y="value"
      c="tone"
      cDomain={["month", "progress", "first", "refund"]}
      cRange={[
        "var(--accent)",
        "color-mix(in oklch, var(--accent) 55%, transparent)",
        "color-mix(in oklch, var(--accent) 35%, transparent)",
        "var(--danger)",
      ]}
      height={200}
      bandPadding={0.32}
      rule={false}
      padding={{ top: 8, right: 8, bottom: 24, left: 48 }}
      onBarClick={selectBar}
      props={{
        xAxis: { format: monthTick, ticks: months.map((month) => month.month) },
        yAxis: {
          format: (value: unknown) => compactAmount.format(Number(value)),
          tickLabelProps: { "data-sensitive": "" },
          ticks: 3,
        },
      }}
    >
      {#snippet marks()}
        <Bars data={plotted} radius={3} rounded="edge" onBarClick={selectBar} key={(month: TrendBar) => month.month} />
        {#if selected.length > 0}
          <Bars data={selected} radius={3} rounded="edge" fill="none" stroke="var(--fg)" strokeWidth={2} class="trend-selected" />
        {/if}
        {#if hasUsual}
          <Bars data={ticks} y={["tickLow", "tickHigh"]} radius={0} fill="var(--fg)" class="trend-usual-tick" key={(month: TrendBar) => month.month} />
        {/if}
      {/snippet}
      {#snippet tooltip({ context })}
        <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
          {#snippet children({ data })}
            {#if data.status !== "before-history"}
              <div class="sparkline-tooltip-body">
                <span>{longMonth(data.month)}{data.status === "in-progress" ? ` · ${$t.spendingInsight.inProgress}` : ""}</span>
                <strong class="money" data-sensitive>{amountText(data.total)}</strong>
                {#if data.usual}
                  <span>{$t.spendingInsight.seriesUsual} <strong class="money" data-sensitive>{amountText(data.usual)}</strong></span>
                {/if}
                {#if data.status === "first-imported"}<span>{$t.spendingInsight.firstImportedMonth}</span>{/if}
              </div>
            {/if}
          {/snippet}
        </Tooltip.Root>
      {/snippet}
    </BarChart>
  </div>
  <div class="trend-legend">
    {#if hasUsual}<span><span class="legend-tick" aria-hidden="true"></span>{$t.spendingInsight.usualTick}</span>{/if}
    {#if inProgress}<span><span class="legend-progress" aria-hidden="true"></span>{shortMonth(inProgress.month)} {$t.spendingInsight.inProgress}</span>{/if}
  </div>

  <ul class="chart-data-summary" aria-label={$t.spendingInsight.trendTitle}>
    {#each months.filter((month) => month.status !== "before-history") as month (month.month)}
      <li>{longMonth(month.month)}: <span class="money" data-sensitive>{amountText(month.total)}</span></li>
    {/each}
  </ul>
</div>

<style>
  .month-trend { position: relative; min-width: 0; }
  .trend-plot { min-width: 0; cursor: pointer; }
  .month-trend :global(.trend-usual-tick), .month-trend :global(.trend-selected) { pointer-events: none; }
  .month-trend :global(.lc-grid line), .month-trend :global(.lc-grid path) { stroke: var(--border); }
  .month-trend :global(.lc-axis-tick-label) { fill: var(--muted); font-size: 11px; }
  .trend-legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin-top: var(--space-2); color: var(--muted); font-size: 12px; }
  .trend-legend > span { display: inline-flex; align-items: center; gap: 6px; }
  .legend-tick { width: 12px; height: 2px; background: var(--fg); }
  .legend-progress { width: 10px; height: 10px; border-radius: 2px; background: color-mix(in oklch, var(--accent) 55%, transparent); }
  .chart-data-summary {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
