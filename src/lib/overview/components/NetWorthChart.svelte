<script lang="ts">
  import { locale } from "$lib/i18n/i18n.ts";
  import type { NetWorthPoint } from "$lib/overview/overview-model.ts";
  import { dayOffset, monthTicks, niceTicks } from "$lib/overview/net-worth-chart.ts";
  import { formatCompact, formatDayWithWeekday, formatMonth, formatTwd } from "$lib/overview/overview-format.ts";

  export let points: NetWorthPoint[] = [];
  export let label = "";

  const HEIGHT = 250;
  const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

  let width = 0;
  let activeIndex: number | null = null;

  $: plotWidth = Math.max(0, width - PAD.left - PAD.right);
  $: plotHeight = HEIGHT - PAD.top - PAD.bottom;
  $: values = points.map((point) => point.value);
  $: ticks = niceTicks(Math.min(...values), Math.max(...values), 6);
  $: yMin = ticks[0] ?? 0;
  $: yMax = ticks.at(-1) ?? 1;
  $: span = points.length > 1 ? dayOffset(points[0]!.date, points.at(-1)!.date) : 0;
  $: xOf = (point: NetWorthPoint) =>
    PAD.left + (span === 0 ? plotWidth : (dayOffset(points[0]!.date, point.date) / span) * plotWidth);
  $: yOf = (value: number) => PAD.top + (1 - (value - yMin) / (yMax - yMin || 1)) * plotHeight;
  $: linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${xOf(point).toFixed(1)},${yOf(point.value).toFixed(1)}`).join("");
  $: areaPath = points.length > 0
    ? `${linePath}L${xOf(points.at(-1)!).toFixed(1)},${PAD.top + plotHeight}L${xOf(points[0]!).toFixed(1)},${PAD.top + plotHeight}Z`
    : "";
  $: xTicks = monthTicks(points);
  $: shownIndex = activeIndex ?? points.length - 1;
  $: shown = points[shownIndex] ?? null;
  $: if (activeIndex !== null && activeIndex >= points.length) activeIndex = null;

  function nearest(event: PointerEvent) {
    const bounds = (event.currentTarget as SVGElement).getBoundingClientRect();
    const x = event.clientX - bounds.left;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(xOf(points[index]!) - x) < Math.abs(xOf(points[best]!) - x)) best = index;
    }
    activeIndex = best;
  }

  function step(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = activeIndex ?? points.length - 1;
    activeIndex = Math.min(points.length - 1, Math.max(0, current + (event.key === "ArrowLeft" ? -1 : 1)));
  }
</script>

<div class="net-worth-chart" bind:clientWidth={width}>
  {#if width > 0 && points.length > 0}
    <svg
      width={width}
      height={HEIGHT}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={points.length - 1}
      aria-valuenow={shownIndex}
      aria-valuetext={shown ? `${formatDayWithWeekday(shown.date, $locale)} ${formatTwd(shown.value, $locale)}` : ""}
      tabindex="0"
      onpointermove={nearest}
      onpointerleave={() => (activeIndex = null)}
      onkeydown={step}
      onblur={() => (activeIndex = null)}
    >
      <g class="grid">
        {#each ticks as tick}
          <line x1={PAD.left} x2={PAD.left + plotWidth} y1={yOf(tick)} y2={yOf(tick)} />
          <text class="y-label" x={PAD.left - 8} y={yOf(tick)} dy="0.32em" text-anchor="end" data-sensitive>{formatCompact(tick, $locale)}</text>
        {/each}
      </g>
      {#each xTicks as tick}
        <text class="x-label" x={xOf(tick)} y={HEIGHT - 8} text-anchor={xOf(tick) < PAD.left + 16 ? "start" : "middle"}>{formatMonth(tick.date, $locale)}</text>
      {/each}
      <path class="area" d={areaPath} />
      <path class="line" d={linePath} />
      {#if shown}
        {@const x = xOf(shown)}
        {@const y = yOf(shown.value)}
        {#if activeIndex !== null}
          <line class="cursor" x1={x} x2={x} y1={PAD.top} y2={PAD.top + plotHeight} />
        {/if}
        <circle class="dot" cx={x} cy={y} r="5" />
        {#if activeIndex !== null}
          {@const flip = x > PAD.left + plotWidth - 150}
          <foreignObject x={flip ? x - 152 : x + 12} y={Math.max(PAD.top, y - 54)} width="140" height="48">
            <div class="tooltip">
              <span>{formatDayWithWeekday(shown.date, $locale)}</span>
              <strong class="money" data-sensitive>{formatTwd(shown.value, $locale)}</strong>
            </div>
          </foreignObject>
        {/if}
      {/if}
    </svg>
  {/if}
</div>

<style>
  .net-worth-chart {
    width: 100%;
    min-height: 250px;
  }

  svg {
    display: block;
    outline: none;
    touch-action: pan-y;
  }

  svg:focus-visible {
    border-radius: var(--radius);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
  }

  .grid line {
    stroke: var(--border);
  }

  .y-label,
  .x-label {
    fill: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .area {
    fill: color-mix(in oklch, var(--accent) 12%, transparent);
  }

  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .cursor {
    stroke: color-mix(in oklch, var(--fg) 24%, transparent);
    stroke-dasharray: 3 3;
  }

  .dot {
    fill: var(--accent);
    stroke: var(--surface);
    stroke-width: 3;
  }

  .tooltip {
    display: grid;
    gap: 2px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: color-mix(in oklch, var(--fg) 92%, transparent);
    color: white;
    font-size: 11px;
    font-weight: 600;
  }

  .tooltip strong {
    font-size: 12px;
    font-weight: 750;
    white-space: nowrap;
  }
</style>
