<script lang="ts">
  import { Area, AreaChart, Tooltip } from "layerchart";
  import { curveLinear, curveStepAfter } from "d3-shape";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildTrendYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
  import type { HistoryChartPoint } from "$lib/shared-accounts/balance-history-chart.ts";
  import { formatAmount } from "$lib/shared-money/money.ts";

  export let points: HistoryChartPoint[];
  /** Ledger balances hold until the next movement, so they draw as steps. */
  export let stepped = false;
  export let tone: "asset" | "liability" = "asset";
  export let today: string;
  export let todayLabel: string;
  export let currency: string;
  export let label: string;
  /** A day pointed at from outside the chart: a hovered table row or statistic, or the last clicked point. */
  export let highlightDay: string | null = null;
  export let onSelectDay: (day: string) => void = () => {};

  type ChartContext = {
    xScale: ((value: string) => number) & { bandwidth?: () => number };
    yScale: (value: number) => number;
    height: number;
  };

  let brushedYDomain: [number, number] | null = null;
  let yRangeReset = 0;
  let lastSignature = "";

  $: signature = `${currency}:${points[0]?.day ?? ""}:${points.at(-1)?.day ?? ""}:${points.length}`;
  $: if (signature !== lastSignature) {
    lastSignature = signature;
    resetYRange();
  }
  $: curve = stepped ? curveStepAfter : curveLinear;
  $: xDomain = points.map((point) => point.position);
  $: yAxis = buildTrendYAxis(points.map((point) => point.balance));
  $: yDomain = brushedYDomain ?? [yAxis.min, yAxis.max];
  $: last = points.at(-1) ?? null;
  $: highlighted = highlightDay === null ? null : points.find((point) => point.day === highlightDay) ?? null;

  function resetYRange() {
    brushedYDomain = null;
    yRangeReset += 1;
  }

  /**
   * The chart owns the zoom, so a click that picks a day leaves it in place;
   * only the reset button clears it. A drag shorter than a few percent of the
   * axis is a wobbling click, not a zoom.
   */
  function trackYRange({ brush }: { brush: { active?: boolean; y: Array<number | Date | string | null>; reset: () => void } }) {
    const [start, end] = brush.y;
    if (!brush.active || typeof start !== "number" || typeof end !== "number") return;
    if (Math.abs(end - start) >= (yDomain[1] - yDomain[0]) * 0.03) brushedYDomain = [Math.min(start, end), Math.max(start, end)];
    brush.reset();
  }

  function pointAt(position: unknown) {
    return typeof position === "string" ? points[Number(position)] ?? null : null;
  }

  function axisDate(position: unknown) {
    const point = pointAt(position);
    if (!point) return "";
    return point === last && point.day === today ? todayLabel : point.day.slice(5);
  }

  function axisAmount(value: unknown) {
    return typeof value === "number" ? formatSparklineTick(value, yAxis.step) : String(value);
  }

  function longDate(day: string) {
    return new Intl.DateTimeFormat($locale, { year: "numeric", month: "short", day: "numeric", weekday: "short", timeZone: "UTC" })
      .format(new Date(`${day}T00:00:00Z`));
  }

  function amount(value: number, signed = false) {
    return formatAmount(value, currency, { locale: $locale, signed });
  }

  /** The centre of a point's band, in plot coordinates. */
  function plotX(context: ChartContext, point: HistoryChartPoint) {
    return context.xScale(point.position) + (context.xScale.bandwidth?.() ?? 0) / 2;
  }

  function inYRange(value: number) {
    return value >= yDomain[0] && value <= yDomain[1];
  }

  function selectPoint(_event: MouseEvent, detail: { data: HistoryChartPoint | null }) {
    if (detail.data) onSelectDay(detail.data.day);
  }
</script>

<div class="history-chart" data-tone={tone} data-history-chart>
  {#if points.length > 0}
    <div class="history-chart-controls">
      {#if brushedYDomain}
        <button class="history-chart-reset" type="button" onclick={resetYRange}>{$t.spending.chartReset}</button>
      {/if}
    </div>
    <div class="history-chart-stage" role="img" aria-label={label}>
      {#key `${signature}:${yRangeReset}`}
        <AreaChart
          data={points}
          x="position"
          y="balance"
          {xDomain}
          {yDomain}
          yBaseline={null}
          yNice={false}
          axis={true}
          grid={{ y: true }}
          rule={false}
          brush={{ axis: "y", zoomOnBrush: false, clickToReset: false, onBrushEnd: trackYRange }}
          tooltipContext={{ mode: "band", onclick: selectPoint }}
          padding={{ top: 12, right: 14, bottom: 24, left: 52 }}
          height={220}
          props={{
            xAxis: { class: "sparkline-axis", format: axisDate, tickSpacing: 80 },
            yAxis: { class: "sparkline-axis", format: axisAmount, tickLabelProps: { "data-sensitive": "" } },
            grid: { class: "sparkline-grid" },
            highlight: { points: { r: 5, class: "history-chart-hover-dot" }, lines: { class: "history-chart-hover-line" } },
          }}
        >
          {#snippet marks({ context }: { context: ChartContext })}
            <Area seriesKey="default" {curve} class="history-chart-area" line={{ class: "history-chart-line" }} />
            {#if highlighted}
              <line
                class="history-chart-pin"
                x1={plotX(context, highlighted)}
                x2={plotX(context, highlighted)}
                y1={0}
                y2={context.height}
              />
              {#if inYRange(highlighted.balance)}
                <circle class="history-chart-pin-dot" cx={plotX(context, highlighted)} cy={context.yScale(highlighted.balance)} r="5" />
              {/if}
            {/if}
            {#if last && inYRange(last.balance)}
              <circle class="history-chart-end-dot" cx={plotX(context, last)} cy={context.yScale(last.balance)} r="4" />
            {/if}
          {/snippet}
          {#snippet tooltip({ context })}
            <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
              {#snippet children({ data }: { data: HistoryChartPoint })}
                <div class="sparkline-tooltip-body history-chart-tooltip">
                  <span>{longDate(data.day)}{data === last && data.day === today ? ` · ${todayLabel}` : ""}</span>
                  <strong data-sensitive>{amount(data.balance)}</strong>
                  {#if data.cycle}
                    <span class="detail num">{data.cycle.start.slice(5).replace("-", "/")} – {data.cycle.end.slice(5).replace("-", "/")}</span>
                  {/if}
                  {#if data.inflow > 0 || data.outflow > 0}
                    <span class="flows num" data-sensitive>
                      {#if data.inflow > 0}<span>{$t.accountHistory.moneyIn} {amount(data.inflow)}</span>{/if}
                      {#if data.outflow > 0}<span>{$t.accountHistory.moneyOut} {amount(data.outflow)}</span>{/if}
                    </span>
                  {:else if data.change !== null && data.change !== 0}
                    <span class="change num" data-sensitive>
                      {$t.accountHistory.changeFromPrevious(amount(data.change, true))}
                    </span>
                  {/if}
                </div>
              {/snippet}
            </Tooltip.Root>
          {/snippet}
        </AreaChart>
      {/key}
    </div>
    <p class="history-chart-hint">{$t.accountHistory.chartHint}</p>
  {/if}
</div>

<style>
  .history-chart {
    --line: var(--accent);
    min-width: 0;
  }

  .history-chart[data-tone="liability"] { --line: var(--danger); }

  .history-chart-controls {
    display: flex;
    justify-content: flex-end;
    min-height: 24px;
  }

  .history-chart-reset {
    min-height: 24px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }

  .history-chart-reset:hover { color: var(--fg); }

  .history-chart-reset:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .history-chart-stage {
    height: 220px;
    cursor: pointer;
  }

  .history-chart-stage :global(.lc-layout-svg) { overflow: hidden; }

  .history-chart :global(.history-chart-area) {
    fill: color-mix(in oklch, var(--line) 12%, transparent);
    fill-opacity: 1;
  }

  .history-chart :global(.history-chart-line) {
    fill: none;
    stroke: var(--line);
    stroke-width: 2;
    stroke-linejoin: round;
  }

  .history-chart :global(.history-chart-end-dot) { fill: var(--line); }

  .history-chart :global(.history-chart-hover-dot),
  .history-chart :global(.history-chart-pin-dot) {
    fill: var(--line);
    stroke: var(--surface);
    stroke-width: 2.5;
  }

  .history-chart :global(.history-chart-hover-line),
  .history-chart :global(.history-chart-pin) {
    stroke: color-mix(in oklch, var(--fg) 30%, transparent);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  .history-chart :global(.history-chart-pin),
  .history-chart :global(.history-chart-pin-dot),
  .history-chart :global(.history-chart-end-dot) { pointer-events: none; }

  .history-chart-tooltip { min-width: 164px; }
  .history-chart-tooltip .detail,
  .history-chart-tooltip .flows,
  .history-chart-tooltip .change {
    font-size: 11px;
    font-weight: 650;
    opacity: 0.86;
  }

  .history-chart-tooltip .flows {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }

  .history-chart-hint {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 11px;
    text-align: right;
  }
</style>
