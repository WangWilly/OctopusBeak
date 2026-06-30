<script lang="ts">
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  type SparklinePoint = {
    date: string;
    value: number;
    x: number;
    y: number;
  };

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";
  let activePoint: SparklinePoint | null = null;
  let points: SparklinePoint[] = [];

  const width = 720;
  const height = 220;
  const left = 54;
  const right = 704;
  const top = 36;
  const bottom = 166;

  $: items = rows
    .map((row) => {
      const amount = row.netAssets.find((item) => item.currency === currency);
      return amount ? { date: row.date, value: amount.value } : null;
    })
    .filter((item): item is { date: string; value: number } => item !== null);
  $: values = items.map((item) => item.value);
  $: min = Math.min(...values);
  $: max = Math.max(...values);
  $: points = items.map((item, index) => {
    const x = values.length === 1 ? (left + right) / 2 : left + (index / (values.length - 1)) * (right - left);
    const y = min === max ? (top + bottom) / 2 : bottom - ((item.value - min) / (max - min)) * (bottom - top);
    return { ...item, x, y };
  });
  $: linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  $: areaPath =
    points.length > 1
      ? `${linePath}L${points[points.length - 1].x} ${bottom}L${points[0].x} ${bottom}Z`
      : "";
  $: gridPath = [`M${left} ${top}H${right}`, `M${left} ${(top + bottom) / 2}H${right}`, `M${left} ${bottom}H${right}`].join("");
  $: yTicks = values.length
    ? [
        { value: max, y: top },
        { value: (min + max) / 2, y: (top + bottom) / 2 },
        { value: min, y: bottom },
      ]
    : [];
  $: xTicks =
    points.length <= 3
      ? points
      : [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]];

  function shortAmount(value: number) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(value);
  }

  function shortDate(value: string) {
    return value.slice(5);
  }

  function tooltipX(point: { x: number }) {
    return Math.min(Math.max(point.x + 12, left), right - 150);
  }

  function tooltipY(point: { y: number }) {
    return Math.max(top, point.y - 62);
  }

  function pointLabel(point: { date: string; value: number }) {
    return `Date: ${point.date}; Net position: ${formatMoney({ currency, value: point.value })}`;
  }
</script>

<svg class="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Net position trend ${currency}`}>
  <text class="sparkline-axis" x="16" y={(top + bottom) / 2} text-anchor="middle" transform={`rotate(-90 16 ${(top + bottom) / 2})`}>
    {currency}
  </text>
  <text class="sparkline-axis" x={(left + right) / 2} y="204" text-anchor="middle">Date</text>
  <path class="sparkline-axis-line" d={`M${left} ${top}V${bottom}H${right}`} />
  {#each yTicks as tick}
    <g class="sparkline-tick">
      <path d={`M${left - 6} ${tick.y}H${left}`} />
      <text data-sensitive x={left - 10} y={tick.y + 4} text-anchor="end">{shortAmount(tick.value)}</text>
    </g>
  {/each}
  {#each xTicks as tick}
    <g class="sparkline-tick">
      <path d={`M${tick.x} ${bottom}V${bottom + 6}`} />
      <text x={tick.x} y={bottom + 22} text-anchor="middle">{shortDate(tick.date)}</text>
    </g>
  {/each}
  <path class="sparkline-grid" d={gridPath} />
  {#if points.length > 1}
    <path class="sparkline-area" d={areaPath} />
    <path class="sparkline-line" d={linePath} />
    {#each points as point}
      <g
        class="sparkline-point"
        role="img"
        aria-label={pointLabel(point)}
        on:pointerenter={() => (activePoint = point)}
        on:pointerleave={() => (activePoint = null)}
      >
        <circle class="sparkline-point-hit" cx={point.x} cy={point.y} r="14" />
        <circle class="sparkline-dot" cx={point.x} cy={point.y} r="5" />
      </g>
    {/each}
  {:else if points.length === 1}
    <g
      class="sparkline-point"
      role="img"
      aria-label={pointLabel(points[0])}
      on:pointerenter={() => (activePoint = points[0])}
      on:pointerleave={() => (activePoint = null)}
    >
      <circle class="sparkline-dot" cx={points[0].x} cy={points[0].y} r="6" />
    </g>
  {:else}
    <text class="sparkline-empty" x="360" y="116" text-anchor="middle">No {currency} history</text>
  {/if}
  {#if activePoint}
    <g class="sparkline-tooltip" transform={`translate(${tooltipX(activePoint)} ${tooltipY(activePoint)})`}>
      <rect width="150" height="48" rx="8" />
      <text x="10" y="19">{activePoint.date}</text>
      <text x="10" y="36">{formatMoney({ currency, value: activePoint.value })}</text>
    </g>
  {/if}
</svg>
