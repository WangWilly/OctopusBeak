<script lang="ts">
  import { BarChart, Text, Tooltip, type BarChartProps, type TextProps } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildSparklineYAxis } from "$lib/overview/components/sparkline-format.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type {
    DailySpendingRow,
    MonthlySpendingRow,
    SpendingCategoryAmounts,
  } from "$lib/spending/model.ts";
  import {
    spendingChartInteractionProps,
    type SpendingChartInteraction,
  } from "./spending-chart-interaction.ts";

  type SpendingChartRow = MonthlySpendingRow | DailySpendingRow;
  type SourceBucket = SpendingCategoryAmounts & {
    bucketKey: string;
    periodKey: string;
    source: "invoice" | "account";
  };

  const categoryColors: Record<SpendingCategory, string> = {
    food: "var(--spending-food, oklch(52% 0.11 250))",
    daily: "var(--spending-daily, oklch(52% 0.09 170))",
    transport: "var(--spending-transport, oklch(56% 0.10 70))",
    shopping: "var(--spending-shopping, oklch(53% 0.08 320))",
    home: "var(--spending-home, oklch(50% 0.07 35))",
    leisure: "var(--spending-leisure, oklch(49% 0.06 215))",
    other: "var(--spending-other, oklch(46% 0.035 250))",
  };

  export let rows: readonly SpendingChartRow[] = [];
  export let kind: "month" | "day" = "month";
  export let selectedKey: string | null = null;
  export let label = "";
  export let onBarClick: ((key: string) => void) | null = null;
  export let interaction: SpendingChartInteraction = "static";

  let stageWidth = 0;
  let selectedCategories: SpendingCategory[] = [];
  let chartContext: BarChartProps<SourceBucket>["context"];
  let transformScale = 1;

  $: interactionProps = spendingChartInteractionProps(interaction);
  $: hasTransform = interactionProps.transform !== undefined;
  $: selectedCategorySet = new Set(selectedCategories);
  $: visibleCategories = SPENDING_CATEGORY_IDS.filter(
    (category) => selectedCategories.length === 0 || selectedCategorySet.has(category),
  );
  $: series = visibleCategories.map((key) => ({
    key,
    label: $t.spending.categories[key],
    color: categoryColors[key],
  }));
  $: buckets = rows.flatMap((row) => ([
    { ...row.invoice, bucketKey: `${rowKey(row)}:invoice`, periodKey: rowKey(row), source: "invoice" },
    { ...row.account, bucketKey: `${rowKey(row)}:account`, periodKey: rowKey(row), source: "account" },
  ] satisfies SourceBucket[]));
  $: periodTicks = rows.map((row) => `${rowKey(row)}:invoice`);
  $: stackExtents = buckets.flatMap((bucket) => [
    visibleCategories.reduce((total, category) => total + Math.min(0, bucket[category]), 0),
    visibleCategories.reduce((total, category) => total + Math.max(0, bucket[category]), 0),
  ]);
  $: yAxis = buildSparklineYAxis([0, ...stackExtents]);
  $: hasNegative = stackExtents.some((value) => value < 0);
  $: yDomain = [hasNegative ? yAxis.min : 0, yAxis.max];
  $: yTicks = yAxis.ticks.filter((tick) => hasNegative || tick >= 0);
  $: hasData = buckets.length > 0 && buckets.some((bucket) =>
    visibleCategories.some((category) => bucket[category] !== 0)
  );
  $: displayLabel = label || (kind === "month" ? $t.spending.monthlyTitle : $t.spending.dailyChart);
  $: ariaLabel = selectedKey ? `${displayLabel}: ${axisLabel(selectedKey)}` : displayLabel;
  $: selectedRow = rows.find((row) => rowKey(row) === selectedKey);
  $: selectedExtents = selectedRow
    ? [
        Math.min(...([selectedRow.invoice, selectedRow.account].map((amounts) =>
          visibleCategories.reduce((total, category) => total + Math.min(0, amounts[category]), 0)
        ))),
        Math.max(...([selectedRow.invoice, selectedRow.account].map((amounts) =>
          visibleCategories.reduce((total, category) => total + Math.max(0, amounts[category]), 0)
        ))),
      ]
    : null;
  $: compactAmount = new Intl.NumberFormat($locale, { maximumFractionDigits: 1, notation: "compact" });

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

  function selectBar(_event: MouseEvent, detail: { data: SourceBucket }) {
    onBarClick?.(detail.data.periodKey);
  }

  function selectTooltip(_event: MouseEvent, detail: { data: SourceBucket }) {
    onBarClick?.(detail.data.periodKey);
  }

  function updateTransform(detail: { scale: number }) {
    transformScale = detail.scale;
  }

  function axisLabel(value: unknown) {
    return dateLabel(String(value).replace(/:(invoice|account)$/u, ""), true);
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
    return typeof value === "number" ? compactAmount.format(value) : String(value);
  }

  function sourceTotal(row: SpendingChartRow, source: "invoice" | "account") {
    return SPENDING_CATEGORY_IDS.reduce((total, category) => total + row[source][category], 0);
  }

  function tooltipRow(bucket: SourceBucket | null | undefined) {
    return bucket ? rows.find((row) => rowKey(row) === bucket.periodKey) : undefined;
  }

  function tooltipValue(row: SpendingChartRow | null | undefined, category: SpendingCategory) {
    return row ? row.invoice[category] + row.account[category] : 0;
  }

  function rowSummary(row: SpendingChartRow) {
    return [
      tooltipLabel(row),
      `${$t.spending.invoiceSource}: ${formatMoney(
        { currency: "TWD", value: sourceTotal(row, "invoice") },
        { locale: $locale },
      )}`,
      `${$t.spending.accountSource}: ${formatMoney(
        { currency: "TWD", value: sourceTotal(row, "account") },
        { locale: $locale },
      )}`,
      `${$t.spending.confirmedTotal}: ${formatMoney(
        { currency: "TWD", value: row.total },
        { locale: $locale },
      )}`,
      ...SPENDING_CATEGORY_IDS.map((category) =>
        `${$t.spending.categories[category]}: ${formatMoney(
          { currency: "TWD", value: tooltipValue(row, category) },
          { locale: $locale },
        )}`
      ),
    ].join(", ");
  }
</script>

{#snippet xTick({ props }: { props: TextProps })}
  <Text
    {...props}
    class={`${props.class ?? ""}${props.value === axisLabel(selectedKey) ? " spending-selected-label" : ""}`}
  />
{/snippet}

<div
  class="spending-bar-chart"
  data-interaction={interaction}
  data-transform-scale={transformScale}
>
  <ul class="spending-chart-summary" aria-label={displayLabel}>
    {#each rows as row (rowKey(row))}
      <li>
        <span class="spending-row-summary">{rowSummary(row)}</span>
        {#if onBarClick}
          <button
            class="spending-row-action"
            type="button"
            aria-label={`${displayLabel}: ${rowSummary(row)}`}
            onclick={() => onBarClick?.(rowKey(row))}
          >
            {tooltipLabel(row)}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if hasTransform}
    <div class="spending-transform-controls" aria-label="Chart transform controls">
      <button type="button" data-action="zoom-in" onclick={() => chartContext?.transform.zoomIn()}>+</button>
      <button type="button" data-action="zoom-out" onclick={() => chartContext?.transform.zoomOut()}>−</button>
      <button
        type="button"
        data-action="reset"
        disabled={transformScale <= 1}
        onclick={() => chartContext?.transform.reset()}
      >Reset</button>
    </div>
  {/if}

  {#if hasData}
    <div
      class="spending-bar-stage"
      role="img"
      aria-label={ariaLabel}
      bind:clientWidth={stageWidth}
    >
      {#if stageWidth > 0}
        <BarChart
        bind:context={chartContext}
        data={buckets}
        x="bucketKey"
        brush={interactionProps.brush}
        transform={interactionProps.transform
          ? { ...interactionProps.transform, onTransform: updateTransform }
          : undefined}
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
        bandPadding={kind === "month" ? 0.58 : 0.66}
        height={320}
        onBarClick={selectBar}
        onTooltipClick={selectTooltip}
        props={{
          bars: { class: "spending-bar-segment", stroke: "var(--surface)", strokeWidth: 1, radius: 9 },
          xAxis: {
            class: "sparkline-axis",
            format: axisLabel,
            ticks: periodTicks,
            tickLabel: xTick,
            tickSpacing: kind === "month" ? 52 : 40,
          },
          yAxis: {
            class: "sparkline-axis",
            format: shortAmount,
            ticks: yTicks,
            tickLabelProps: { "data-sensitive": "" },
          },
          grid: { class: "sparkline-grid" },
        }}
      >
        {#snippet aboveMarks({ context })}
          {#if selectedKey && selectedExtents}
            {@const invoiceX = Number(context.xScale(`${selectedKey}:invoice`))}
            {@const accountX = Number(context.xScale(`${selectedKey}:account`))}
            {@const bucketWidth = Number(context.xScale.bandwidth?.() ?? 0)}
            {@const y1 = Number(context.yScale(selectedExtents[0]))}
            {@const y2 = Number(context.yScale(selectedExtents[1]))}
            {#if [invoiceX, accountX, bucketWidth, y1, y2].every(Number.isFinite) && bucketWidth > 0}
              <rect
                class="spending-selected-band"
                x={invoiceX - 4}
                y={Math.min(y1, y2) - 4}
                width={accountX + bucketWidth - invoiceX + 8}
                height={Math.abs(y2 - y1) + 8}
                rx="10"
              ></rect>
            {/if}
          {/if}
        {/snippet}

        {#snippet tooltip({ context })}
          <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
            {#snippet children({ data })}
              {@const row = tooltipRow(data)}
              <div class="sparkline-tooltip-body spending-tooltip">
                <span>{row ? tooltipLabel(row) : ""}</span>
                <div class="spending-tooltip-row">
                  <span>{$t.spending.invoiceSource}</span>
                  <strong data-sensitive>{formatMoney(
                    { currency: "TWD", value: row ? sourceTotal(row, "invoice") : 0 },
                    { locale: $locale },
                  )}</strong>
                </div>
                <div class="spending-tooltip-row">
                  <span>{$t.spending.accountSource}</span>
                  <strong data-sensitive>{formatMoney(
                    { currency: "TWD", value: row ? sourceTotal(row, "account") : 0 },
                    { locale: $locale },
                  )}</strong>
                </div>
                <div class="spending-tooltip-row spending-tooltip-total">
                  <span>{$t.spending.confirmedTotal}</span>
                  <strong data-sensitive>{formatMoney(
                    { currency: "TWD", value: row?.total ?? 0 },
                    { locale: $locale },
                  )}</strong>
                </div>
                {#each series as item}
                  <div class="spending-tooltip-row">
                    <span>{item.label}</span>
                    <strong data-sensitive>{formatMoney(
                      { currency: "TWD", value: tooltipValue(row, item.key) },
                      { locale: $locale },
                    )}</strong>
                  </div>
                {/each}
              </div>
            {/snippet}
          </Tooltip.Root>
        {/snippet}
        </BarChart>
      {/if}
    </div>

  {:else}
    <div class="spending-bar-stage spending-chart-empty" role="img" aria-label={ariaLabel}>
      {$t.spending.noChartData}
    </div>
  {/if}

  {#if rows.length > 0}
    <div class="spending-source-key" aria-label={$t.spending.sourceKeyAria}>
      <span>{$t.spending.leftSource}</span>
      <span>{$t.spending.rightSource}</span>
    </div>
    <div class="spending-legend" role="group" aria-label={$t.spending.categoryLegendAria}>
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
  {/if}
</div>

<style>
  .spending-bar-chart {
    position: relative;
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

  .spending-bar-stage :global(.spending-selected-band) {
    fill: none;
    stroke: var(--fg);
    stroke-width: 2;
    pointer-events: none;
    vector-effect: non-scaling-stroke;
  }

  .spending-bar-stage :global(.spending-selected-label) {
    fill: var(--fg);
    font-weight: 800;
  }

  .spending-transform-controls {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 16px 8px;
  }

  .spending-transform-controls button {
    min-width: 36px;
    min-height: 32px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }

  .spending-transform-controls button:disabled {
    opacity: 0.4;
  }

  .spending-transform-controls button:focus-visible {
    outline: 2px solid var(--accent);
  }

  .spending-chart-summary {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    pointer-events: none;
  }

  .spending-row-summary,
  .spending-row-action {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    border: 0;
    white-space: nowrap;
  }

  .spending-row-action {
    top: 8px;
    left: 8px;
    pointer-events: none;
  }

  .spending-row-action:focus-visible {
    z-index: 2;
    width: auto;
    height: auto;
    margin: 0;
    padding: 7px 10px;
    overflow: visible;
    clip: auto;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    pointer-events: auto;
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

  .spending-tooltip-total {
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }

  .spending-source-key {
    display: flex;
    justify-content: center;
    gap: 22px;
    padding: 6px 20px 0;
    color: var(--muted);
    font-size: 11px;
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
