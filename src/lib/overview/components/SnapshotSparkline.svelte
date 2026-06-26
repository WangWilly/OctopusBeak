<script lang="ts">
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";

  const width = 720;
  const height = 220;
  const top = 44;
  const bottom = 176;

  $: values = rows
    .map((row) => row.netAssets.find((amount) => amount.currency === currency)?.value)
    .filter((value): value is number => value !== undefined);
  $: min = Math.min(...values);
  $: max = Math.max(...values);
  $: points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = min === max ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top);
    return { x, y };
  });
  $: linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  $: areaPath =
    points.length > 1
      ? `${linePath}L${points[points.length - 1].x} ${height}L${points[0].x} ${height}Z`
      : "";
</script>

<svg class="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Net position trend ${currency}`}>
  <path class="sparkline-grid" d="M0 44H720M0 110H720M0 176H720" />
  {#if points.length > 1}
    <path class="sparkline-area" d={areaPath} />
    <path class="sparkline-line" d={linePath} />
  {:else if points.length === 1}
    <circle class="sparkline-dot" cx={points[0].x} cy={points[0].y} r="6" />
  {:else}
    <text class="sparkline-empty" x="360" y="116" text-anchor="middle">No {currency} history</text>
  {/if}
</svg>
