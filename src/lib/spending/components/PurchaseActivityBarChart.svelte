<script lang="ts" module>
  export type PurchaseActivityDatum = Readonly<{
    key: string;
    label: string;
    value: number;
    tone: "spend" | "refund";
  }>;
</script>

<script lang="ts">
  import { BarChart, defaultChartPadding } from "layerchart";
  import { locale } from "$lib/i18n/i18n.ts";

  export let data: readonly PurchaseActivityDatum[] = [];
  export let selectedKey: string | null = null;
  export let label = "";
  export let onSelect: ((key: string) => void) | null = null;

  $: compactAmount = new Intl.NumberFormat($locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  $: hasValue = data.some((datum) => datum.value !== 0);

  function selectBar(_event: MouseEvent, detail: { data: PurchaseActivityDatum }) {
    onSelect?.(detail.data.key);
  }
</script>

<div class="purchase-activity-chart" data-purchase-activity-chart data-selected-key={selectedKey ?? ""}>
  {#if hasValue}
    <BarChart
      {data}
      x="label"
      y="value"
      c="tone"
      cDomain={["spend", "refund"]}
      cRange={["var(--accent)", "var(--danger)"]}
      height={280}
      bandPadding={0.38}
      padding={defaultChartPadding({ left: 48, bottom: 34, right: 12, top: 12 })}
      onBarClick={selectBar}
      props={{
        xAxis: { format: "none", tickSpacing: 40 },
        yAxis: { format: (value: unknown) => compactAmount.format(Number(value)) },
        bars: { radius: 5, rounded: "top" },
        tooltip: { header: { format: "none" } },
      }}
    />
  {:else}
    <div class="chart-empty">
      <strong>{$locale === "zh-TW" ? "這個期間沒有消費" : "No spending in this period"}</strong>
      <span>{$locale === "zh-TW" ? "選擇其他月份或幣別查看趨勢。" : "Choose another month or currency to view its trend."}</span>
    </div>
  {/if}

  <ul class="chart-data-summary" aria-label={label}>
    {#each data as datum (datum.key)}
      <li>{datum.label}: {datum.value}</li>
    {/each}
  </ul>
</div>

<style>
  .purchase-activity-chart { min-width: 0; }
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
    min-height: 280px;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-2);
    color: var(--muted);
    text-align: center;
  }
  .chart-empty strong { color: var(--fg); }
</style>
