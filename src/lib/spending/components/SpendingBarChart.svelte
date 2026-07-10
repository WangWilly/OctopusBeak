<script lang="ts">
  import { BarChart, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildSparklineYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type { DailySpendingRow, MonthlySpendingRow } from "$lib/spending/model.ts";

  type SpendingChartRow = MonthlySpendingRow | DailySpendingRow;

  const categoryColors: Record<SpendingCategory, string> = {
    food: "var(--spending-food, oklch(63% 0.15 38))",
    daily: "var(--spending-daily, oklch(59% 0.14 150))",
    transport: "var(--spending-transport, oklch(58% 0.14 245))",
    shopping: "var(--spending-shopping, oklch(61% 0.14 310))",
    home: "var(--spending-home, oklch(70% 0.13 88))",
    leisure: "var(--spending-leisure, oklch(61% 0.12 190))",
    other: "var(--spending-other, oklch(58% 0.025 250))",
  };

  export let rows: readonly SpendingChartRow[] = [];
  export let kind: "month" | "day" = "month";
  export let selectedKey: string | null = null;
  export let label = "";
  export let onBarClick: ((key: string) => void) | null = null;

  let selectedCategories: SpendingCategory[] = [];

  $: selectedCategorySet = new Set(selectedCategories);
  $: visibleCategories = SPENDING_CATEGORY_IDS.filter(
    (category) => selectedCategories.length === 0 || selectedCategorySet.has(category),
  );
  $: series = visibleCategories.map((key) => ({
    key,
    label: $t.spending.categories[key],
    color: categoryColors[key],
  }));
  $: xValues = rows.map(rowKey);
  $: stackExtents = rows.flatMap((row) => [
    visibleCategories.reduce((total, category) => total + Math.min(0, row[category]), 0),
    visibleCategories.reduce((total, category) => total + Math.max(0, row[category]), 0),
  ]);
  $: yAxis = buildSparklineYAxis([0, ...stackExtents]);
  $: hasNegative = stackExtents.some((value) => value < 0);
  $: yDomain = [hasNegative ? yAxis.min : 0, yAxis.max];
  $: yTicks = yAxis.ticks.filter((tick) => hasNegative || tick >= 0);
  $: hasData = rows.length > 0 && rows.some((row) => SPENDING_CATEGORY_IDS.some((category) => row[category] !== 0));
  $: displayLabel = label || (kind === "month" ? $t.spending.monthlyTitle : $t.spending.dailyChart);
  $: ariaLabel = selectedKey ? `${displayLabel}: ${axisLabel(selectedKey)}` : displayLabel;

  function rowKey(row: SpendingChartRow) {
    return "month" in row ? row.month : row.date;
  }

  function toggleCategory(category: SpendingCategory) {
    if (selectedCategories.length === 0) {
      selectedCategories = [category];
    } else if (selectedCategorySet.has(category)) {
      selectedCategories = selectedCategories.filter((item) => item !== category);
    } else {
      selectedCategories = [...selectedCategories, category];
    }
  }

  function selectBar(_event: MouseEvent, detail: { data: SpendingChartRow }) {
    onBarClick?.(rowKey(detail.data));
  }

  function selectTooltip(_event: MouseEvent, detail: { data: SpendingChartRow }) {
    onBarClick?.(rowKey(detail.data));
  }

  function axisLabel(value: unknown) {
    return dateLabel(String(value), true);
  }

  function tooltipLabel(row: SpendingChartRow) {
    return dateLabel(rowKey(row), false);
  }

  function dateLabel(value: string, short: boolean) {
    const [year, month, day = 1] = value.split("-").map(Number);
    if (!year || !month || !day) return value;
    const date = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat($locale, kind === "month"
      ? { year: short ? "2-digit" : "numeric", month: short ? "2-digit" : "long", timeZone: "UTC" }
      : { month: short ? "numeric" : "long", day: "numeric", timeZone: "UTC" }
    ).format(date);
  }

  function shortAmount(value: unknown) {
    return typeof value === "number" ? formatSparklineTick(value, yAxis.step) : String(value);
  }

  function tooltipValue(row: SpendingChartRow | null | undefined, category: SpendingCategory) {
    return row?.[category] ?? 0;
  }
</script>

{#if hasData}
  <div class="spending-bar-chart" role="img" aria-label={ariaLabel}>
    <div class="spending-bar-stage">
      <BarChart
        data={rows}
        x={rowKey}
        {series}
        seriesLayout="stack"
        {yDomain}
        yBaseline={0}
        yNice={false}
        axis={true}
        grid={{ y: true }}
        legend={false}
        tooltipContext={{ mode: "band", findTooltipData: "closest" }}
        padding={{ top: 16, right: 16, bottom: 36, left: 58 }}
        bandPadding={0.36}
        height={320}
        onBarClick={selectBar}
        onTooltipClick={selectTooltip}
        props={{
          bars: { class: "spending-bar-segment", stroke: "var(--surface)", strokeWidth: 1, radius: 2 },
          xAxis: { class: "sparkline-axis", format: axisLabel, ticks: xValues },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            ticks: yTicks,
            tickLabelProps: { "data-sensitive": "" },
          },
          grid: { class: "sparkline-grid" },
        }}
      >
        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              <div class="sparkline-tooltip-body spending-tooltip">
                <span>{data ? tooltipLabel(data) : ""}</span>
                {#each series as item}
                  <div class="spending-tooltip-row">
                    <span>{item.label}</span>
                    <strong data-sensitive>{formatMoney({ currency: "TWD", value: tooltipValue(data, item.key) })}</strong>
                  </div>
                {/each}
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
      </BarChart>
    </div>

    <div class="spending-legend" aria-label={$t.spending.categoryLegendAria}>
      {#each SPENDING_CATEGORY_IDS as category}
        <button
          class:selected={selectedCategories.length === 0 || selectedCategorySet.has(category)}
          class="spending-legend-item"
          type="button"
          title={$t.spending.categories[category]}
          aria-pressed={selectedCategories.length === 0 || selectedCategorySet.has(category)}
          onclick={() => toggleCategory(category)}
        >
          <span class="spending-legend-swatch" style:background-color={categoryColors[category]}></span>
          <span class="spending-legend-label">{$t.spending.categories[category]}</span>
        </button>
      {/each}
    </div>
  </div>
{:else}
  <div class="spending-bar-chart spending-chart-empty" role="img" aria-label={ariaLabel}>
    {$t.spending.noChartData}
  </div>
{/if}

<style>
  .spending-bar-chart {
    width: 100%;
    min-width: 0;
    min-height: 356px;
  }

  .spending-bar-stage {
    width: 100%;
    height: 320px;
  }

  .spending-bar-stage :global(.lc-layout-svg) {
    width: 100%;
    height: 100%;
    display: block;
  }

  .spending-bar-stage :global(.spending-bar-segment) {
    cursor: pointer;
  }

  .spending-tooltip {
    min-width: 210px;
    gap: 5px;
  }

  .spending-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .spending-legend {
    max-width: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 14px;
    padding: 6px 20px 0;
  }

  .spending-legend-item {
    min-width: 0;
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    opacity: 0.38;
  }

  .spending-legend-item.selected {
    opacity: 1;
  }

  .spending-legend-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .spending-legend-swatch {
    width: 9px;
    height: 9px;
    flex: 0 0 auto;
    border-radius: 999px;
  }

  .spending-legend-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spending-chart-empty {
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 14px;
    font-weight: 700;
  }
</style>
