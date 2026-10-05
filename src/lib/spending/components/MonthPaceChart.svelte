<script lang="ts">
  import { Area, AreaChart, BarChart, Bars, Points, Rule, Spline, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { CurrencyMonthReading, DayReading, MonthSpan, PacePoint } from "../spending-insights.ts";
  import { moneyText, type ExactMoney } from "./money-text.ts";

  export let reading: CurrencyMonthReading;
  export let span: MonthSpan;
  export let selectedDay: string | null = null;
  export let onSelectDay: (date: string) => void = () => {};

  const BAND_PADDING = 0.3;
  const PLOT_LEFT = 56;
  const PLOT_RIGHT = 16;

  $: daysInMonth = span.daysInMonth;
  $: throughDay = span.kind === "in-progress" ? span.throughDay : daysInMonth;
  $: xDomain = [0.5 - BAND_PADDING / 2, daysInMonth + 0.5 + BAND_PADDING / 2];
  $: dayTicks = [...new Set([1, 5, 10, 15, 20, 25, daysInMonth])];
  $: compactAmount = new Intl.NumberFormat($locale, { notation: "compact", maximumFractionDigits: 1 });
  $: hasUsual = reading.usual.kind === "available";
  $: paceValues = reading.pace.flatMap((point) => [point.cumulative, point.usualLow, point.usualHigh])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  $: paceDomain = [Math.min(0, ...paceValues), Math.max(1, ...paceValues)];
  $: lastPoint = reading.pace[throughDay - 1] ?? null;
  $: selected = reading.days.find((day) => day.date === selectedDay) ?? null;
  $: stripBars = reading.days.filter((day) => day.tone !== "future" && day.value !== 0);
  $: hasSpending = reading.days.some((day) => day.tone !== "quiet" && day.tone !== "future");

  function amountText(amount: ExactMoney) {
    return moneyText(amount, $locale);
  }

  function dayText(date: string) {
    return new Intl.DateTimeFormat($locale, { month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(`${date}T00:00:00Z`));
  }

  function dayTick(value: unknown) {
    return dayTicks.includes(Number(value)) ? String(value) : "";
  }

  function selectBar(_event: MouseEvent, detail: { data: DayReading }) {
    onSelectDay(detail.data.date);
  }

  function paceDate(point: PacePoint) {
    return reading.days[point.day - 1]?.date ?? "";
  }
</script>

<div class="month-pace" data-pace-chart data-selected-day={selectedDay ?? ""}>
  {#if hasSpending || hasUsual}
    <div class="pace-plot" role="img" aria-label={$t.spendingInsight.paceAria}>
      <AreaChart
        data={reading.pace}
        x="day"
        y="cumulative"
        {xDomain}
        yDomain={paceDomain}
        yNice
        height={240}
        axis="y"
        grid={{ y: true }}
        rule={false}
        legend={false}
        highlight={{ lines: true, points: false }}
        padding={{ top: 12, right: PLOT_RIGHT, bottom: 8, left: PLOT_LEFT }}
        props={{
          yAxis: {
            format: (value: unknown) => compactAmount.format(Number(value)),
            tickLabelProps: { "data-sensitive": "" },
            ticks: 4,
          },
        }}
      >
        {#snippet marks()}
          {#if hasUsual}
            <Area y0="usualLow" y1="usualHigh" defined={(point: PacePoint) => point.usualLow !== null} line={false} class="pace-usual-range" />
            <Spline y="usual" defined={(point: PacePoint) => point.usual !== null} class="pace-usual-line" />
          {/if}
          <Spline y="cumulative" defined={(point: PacePoint) => point.cumulative !== null} class="pace-line" />
          {#if lastPoint && lastPoint.cumulative !== null}
            <Points data={[lastPoint]} x="day" y="cumulative" r={4} class="pace-end-dot" />
          {/if}
          {#if selected}
            <Rule x={selected.day} class="pace-selected-rule" />
          {/if}
        {/snippet}
        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              <div class="sparkline-tooltip-body pace-tooltip">
                <span>{dayText(paceDate(data))}</span>
                {#if data.amount}
                  <span class="pace-tooltip-row">{$t.spendingInsight.seriesThisMonth} <strong class="money" data-sensitive>{amountText(data.amount)}</strong></span>
                {/if}
                {#if data.usualAmount}
                  <span class="pace-tooltip-row">{$t.spendingInsight.seriesUsual} <strong class="money" data-sensitive>{amountText(data.usualAmount)}</strong></span>
                {/if}
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </AreaChart>
    </div>
    <div class="pace-strip" data-daily-strip>
      <BarChart
        data={reading.days}
        x="day"
        y="value"
        xDomain={reading.days.map((day) => day.day)}
        c="tone"
        cDomain={["spend", "heavy", "refund", "quiet", "future"]}
        cRange={["color-mix(in oklch, var(--accent) 55%, transparent)", "var(--accent)", "var(--danger)", "transparent", "transparent"]}
        height={96}
        bandPadding={BAND_PADDING}
        rule={false}
        padding={{ top: 6, right: PLOT_RIGHT, bottom: 24, left: PLOT_LEFT }}
        onBarClick={selectBar}
        props={{
          xAxis: { format: dayTick, ticks: reading.days.map((day) => day.day), tickLabelProps: { class: "strip-day-tick" } },
          yAxis: {
            format: (value: unknown) => compactAmount.format(Number(value)),
            tickLabelProps: { "data-sensitive": "" },
            ticks: 2,
          },
        }}
      >
        {#snippet marks()}
          <Bars data={stripBars} radius={2} rounded="edge" onBarClick={selectBar} key={(day: DayReading) => day.date} />
          {#if selected && selected.value !== 0}
            <Bars data={[selected]} radius={2} rounded="edge" fill="none" stroke="var(--fg)" strokeWidth={2} class="strip-selected" />
          {/if}
        {/snippet}
        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              {#if data.tone !== "future"}
                <div class="sparkline-tooltip-body">
                  <span>{dayText(data.date)} · {$t.purchaseSpending.dayPurchasesCount(data.recordCount)}</span>
                  <strong class="money" data-sensitive>{amountText(data.net)}</strong>
                </div>
              {/if}
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </BarChart>
    </div>
    {#if reading.heavyThreshold && reading.days.some((day) => day.tone === "heavy")}
      <p class="strip-legend"><span class="strip-swatch" aria-hidden="true"></span>{$t.spendingInsight.heavyLegend} <span class="money" data-sensitive>{amountText(reading.heavyThreshold)}</span></p>
    {/if}
  {:else}
    <div class="chart-empty">
      <strong>{$t.purchaseSpending.chartNoSpending}</strong>
      <span>{$t.purchaseSpending.chartEmptyTrend}</span>
    </div>
  {/if}

  <ul class="chart-data-summary" aria-label={$t.purchaseSpending.dailySpending}>
    {#each reading.days.filter((day) => day.tone !== "future") as day (day.date)}
      <li>{dayText(day.date)}: <span class="money" data-sensitive>{amountText(day.net)}</span></li>
    {/each}
  </ul>
</div>

<style>
  .month-pace { position: relative; min-width: 0; }
  .pace-plot, .pace-strip { min-width: 0; }
  .pace-strip { margin-top: calc(var(--space-1) * -1); cursor: pointer; }
  .month-pace :global(.pace-usual-range) { fill: color-mix(in oklch, var(--muted) 12%, transparent); stroke: none; }
  .month-pace :global(.pace-usual-line) { fill: none; stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 4 4; }
  .month-pace :global(.pace-line) { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
  .month-pace :global(.pace-end-dot) { fill: var(--accent); stroke: white; stroke-width: 3; }
  .month-pace :global(.pace-selected-rule) { stroke: var(--fg); stroke-width: 1; opacity: 0.6; }
  .month-pace :global(.strip-selected) { pointer-events: none; }
  .month-pace :global(.lc-grid line), .month-pace :global(.lc-grid path) { stroke: var(--border); }
  .month-pace :global(.lc-axis-tick-label) { fill: var(--muted); font-size: 11px; }
  .pace-tooltip-row { display: flex; justify-content: space-between; gap: var(--space-3); font-weight: 600; }
  .strip-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: var(--space-2) 0 0; padding-left: 56px; color: var(--muted); font-size: 12px; }
  .strip-swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--accent); }
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
  .chart-empty {
    min-height: 240px;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-2);
    color: var(--muted);
    text-align: center;
  }
  .chart-empty strong { color: var(--fg); }
  @media (max-width: 680px) {
    .strip-legend { padding-left: 0; }
  }
</style>
