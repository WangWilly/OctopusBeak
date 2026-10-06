<script lang="ts">
  import { locale } from "$lib/i18n/i18n.ts";
  import type { HistoryPoint } from "$lib/shared-accounts/balance-history.ts";

  export let points: HistoryPoint[];
  /** Ledger balances hold until the next movement, so they draw as steps. */
  export let stepped = false;
  export let tone: "asset" | "liability" = "asset";
  export let today: string;
  export let todayLabel: string;
  export let currency: string;
  export let label: string;

  const HEIGHT = 170;
  const PAD = { top: 12, right: 12, bottom: 26, left: 64 };
  const TICKS = 4;

  let width = 800;

  $: values = points.map((point) => point.balance);
  $: scale = niceScale(Math.min(...values), Math.max(...values));
  $: plotWidth = Math.max(1, width - PAD.left - PAD.right);
  $: plotHeight = HEIGHT - PAD.top - PAD.bottom;
  // A lone point has no span to cover, so it sits in the middle of the plot.
  $: x = (index: number) => PAD.left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  $: y = (value: number) => PAD.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;
  $: path = linePath(points, stepped, x, y);
  $: area = path ? `${path} L${x(points.length - 1)},${PAD.top + plotHeight} L${x(0)},${PAD.top + plotHeight} Z` : "";
  $: xLabels = axisLabels(points, today, todayLabel, $locale);
  $: last = points.at(-1) ?? null;
  $: number = new Intl.NumberFormat($locale, { maximumFractionDigits: 0 });

  function niceScale(low: number, high: number) {
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: 0, max: 1, step: 1 };
    const span = high - low || Math.abs(high) || 1;
    const rough = span / TICKS;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
    const min = Math.floor((low - span * 0.05) / step) * step;
    const max = Math.ceil((high + span * 0.05) / step) * step;
    return { min: Math.max(low >= 0 ? 0 : min, min), max, step };
  }

  function linePath(source: HistoryPoint[], step: boolean, toX: typeof x, toY: typeof y) {
    if (source.length === 0) return "";
    return source.map((point, index) => {
      if (index === 0) return `M${toX(0)},${toY(point.balance)}`;
      return step
        ? `H${toX(index)} V${toY(point.balance)}`
        : `L${toX(index)},${toY(point.balance)}`;
    }).join(" ");
  }

  /** Month names for long ranges, day labels otherwise; the final point reads as today. */
  function axisLabels(source: HistoryPoint[], todayDay: string, todayText: string, language: string) {
    if (source.length === 0) return [];
    const long = source.length > 120 || (source.length > 1 && source[0].day.slice(0, 7) !== source.at(-1)!.day.slice(0, 7) && source.length < 20);
    const labels: { index: number; text: string }[] = [];
    if (long) {
      let lastMonth = "";
      source.forEach((point, index) => {
        const month = point.day.slice(0, 7);
        if (month === lastMonth) return;
        lastMonth = month;
        labels.push({
          index,
          text: new Intl.DateTimeFormat(language, { month: "short", timeZone: "UTC" }).format(new Date(`${point.day}T00:00:00Z`)),
        });
      });
    } else {
      const every = Math.max(1, Math.ceil(source.length / 5));
      source.forEach((point, index) => {
        if (index % every === 0) labels.push({ index, text: point.day.slice(5).replace("-", "/") });
      });
    }
    const lastIndex = source.length - 1;
    const filtered = labels.filter((item) => lastIndex - item.index >= Math.max(1, source.length / 12) || item.index === lastIndex);
    if (source[lastIndex].day === todayDay) {
      return [...filtered.filter((item) => item.index !== lastIndex), { index: lastIndex, text: todayText }];
    }
    return filtered;
  }
</script>

<div class="history-chart" data-tone={tone} bind:clientWidth={width}>
  {#if points.length > 0}
    <svg {width} height={HEIGHT} role="img" aria-label={label}>
      {#each Array.from({ length: Math.round((scale.max - scale.min) / scale.step) + 1 }, (_, index) => scale.min + index * scale.step) as tick}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
        <text class="y-label num" x={PAD.left - 10} y={y(tick)} dominant-baseline="middle" text-anchor="end">{number.format(tick)}</text>
      {/each}
      <path class="area" d={area} />
      <path class="line" d={path} />
      {#if !stepped && points.length <= 60}
        {#each points as point, index}
          <circle class="dot" cx={x(index)} cy={y(point.balance)} r="3" />
        {/each}
      {/if}
      {#each xLabels as item}
        <text
          class="x-label num"
          class:today={item.index === points.length - 1 && last?.day === today}
          x={x(item.index)}
          y={HEIGHT - 6}
          text-anchor={item.index === points.length - 1 && points.length > 1 ? "end" : "middle"}
        >{item.text}</text>
      {/each}
      {#if last}
        <circle class="end-dot" cx={x(points.length - 1)} cy={y(last.balance)} r="5" />
      {/if}
    </svg>
    {#if last && last.day === today}
      <span
        class="end-label num"
        class:centered={points.length === 1}
        style:left={`${x(points.length - 1)}px`}
        style:top={`${Math.max(0, y(last.balance) - 34)}px`}
        data-sensitive
      >{todayLabel} {currency} {number.format(last.balance)}</span>
    {/if}
  {/if}
</div>

<style>
  .history-chart {
    --line: var(--accent);
    position: relative;
    min-height: 170px;
  }

  .history-chart[data-tone="liability"] { --line: var(--danger); }

  svg { display: block; overflow: visible; }
  .grid { stroke: var(--border); stroke-width: 1; }

  .y-label,
  .x-label {
    fill: var(--muted);
    font-size: 10px;
  }

  .x-label.today { fill: var(--fg); font-weight: 750; }

  .line {
    fill: none;
    stroke: var(--line);
    stroke-width: 2;
    stroke-linejoin: round;
  }

  .area {
    fill: color-mix(in oklch, var(--line) 10%, transparent);
  }

  .dot {
    fill: var(--surface);
    stroke: var(--line);
    stroke-width: 1.5;
  }

  .end-dot { fill: var(--line); }

  .end-label {
    position: absolute;
    transform: translateX(calc(-100% + 8px));
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--fg);
    color: var(--surface);
    font-size: 11px;
    font-weight: 750;
    white-space: nowrap;
  }

  .end-label.centered { transform: translateX(-50%); }
</style>
