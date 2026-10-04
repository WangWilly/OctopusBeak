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
  import { locale, t } from "$lib/i18n/i18n.ts";

  export let data: readonly PurchaseActivityDatum[] = [];
  export let selectedKey: string | null = null;
  export let label = "";
  export let onSelect: ((key: string) => void) | null = null;

  $: compactAmount = new Intl.NumberFormat($locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  $: hasValue = data.some((datum) => datum.value !== 0);
  $: barData = data.filter((datum) => datum.value !== 0);

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
        yAxis: {
          format: (value: unknown) => compactAmount.format(Number(value)),
          tickLabelProps: { "data-sensitive": "" },
        },
        bars: { radius: 5, rounded: "top", data: barData, key: (datum: PurchaseActivityDatum) => datum.key },
        tooltip: {
          root: { portal: false },
          header: { format: "none" },
          item: { classes: { value: "money" } },
        },
      }}
    />
  {:else}
    <div class="chart-empty">
      <strong>{$t.purchaseSpending.chartNoSpending}</strong>
      <span>{$t.purchaseSpending.chartEmptyTrend}</span>
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
