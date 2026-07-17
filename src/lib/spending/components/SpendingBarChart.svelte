<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    Axis,
    Bar,
    Chart,
    groupStackData,
    Highlight,
    Layer,
    Rect,
    Text,
    Tooltip,
    type TextProps,
  } from "layerchart";
  import { ChartClipPath as CanvasChartClipPath } from "layerchart/canvas";
  import { ChartClipPath as SvgChartClipPath } from "layerchart/svg";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { buildSparklineYAxis } from "$lib/overview/components/sparkline-format.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type {
    DailySpendingRow,
    MonthlySpendingRow,
  } from "$lib/spending/model.ts";
  import {
    spendingChartInteractionProps,
    spendingChartViewport,
    type SpendingChartInteraction,
  } from "./spending-chart-interaction.ts";
  import {
    spendingChartInitialTransform,
    spendingChartRenderWindow,
  } from "./spending-chart-window.ts";

  type SpendingChartRow = MonthlySpendingRow | DailySpendingRow;
  type SpendingSource = "invoice" | "account";
  type SpendingStackKey = SpendingCategory | "pending";
  type LongDatum = {
    periodKey: string;
    source: SpendingSource;
    category: SpendingStackKey;
    value: number;
  };
  type GroupStackDatum = LongDatum & {
    keys: Record<string, unknown>;
    values: number[];
    data: LongDatum[];
  };
  type TransformDetail = { scale: number; translate: { x: number; y: number } };
  type BandScale = ((value: string) => unknown) & { bandwidth?: () => number };

  const horizontalPadding = 58 + 16;
  const sources: SpendingSource[] = ["invoice", "account"];

  const categoryColors: Record<SpendingCategory, string> = {
    food: "var(--spending-food, oklch(52% 0.11 250))",
    daily: "var(--spending-daily, oklch(52% 0.09 170))",
    transport: "var(--spending-transport, oklch(56% 0.10 70))",
    shopping: "var(--spending-shopping, oklch(53% 0.08 320))",
    home: "var(--spending-home, oklch(50% 0.07 35))",
    leisure: "var(--spending-leisure, oklch(49% 0.06 215))",
    other: "var(--spending-other, oklch(46% 0.035 250))",
  };
  const emptyAmounts: Record<SpendingCategory, number> = {
    food: 0,
    daily: 0,
    transport: 0,
    shopping: 0,
    home: 0,
    leisure: 0,
    other: 0,
  };

  export let rows: readonly SpendingChartRow[] = [];
  export let kind: "month" | "day" = "month";
  export let selectedKey: string | null = null;
  export let label = "";
  export let onBarClick: ((key: string) => void) | null = null;
  export let interaction: SpendingChartInteraction = "static";
  export let showPending = false;

  let stageWidth = 0;
  let latestStageWidth = 0;
  let stageElement: HTMLDivElement;
  let resizeSurface: HTMLDivElement;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedCategories: SpendingCategory[] = [];
  let chartResetKey = 0;
  let transformScale: number | undefined;
  let transformTranslateX: number | undefined;
  let transformDragging = false;
  let pendingTransform: TransformDetail | undefined;
  let transformFrame: number | undefined;
  let roundedBarKeys = new Set<string>();

  $: interactionProps = spendingChartInteractionProps(interaction);
  $: hasTransform = interactionProps.transform !== undefined;
  $: plotWidth = Math.max(0, stageWidth - horizontalPadding);
  $: initialTransform = spendingChartInitialTransform(rows.length, plotWidth);
  $: currentTransformScale = hasTransform ? transformScale ?? initialTransform.scale : 1;
  $: currentTransformTranslateX = hasTransform
    ? transformTranslateX ?? initialTransform.translateX
    : 0;
  $: chartTransform = interactionProps.transform
    ? {
        ...interactionProps.transform,
        initialScale: initialTransform.scale,
        initialTranslate: { x: initialTransform.translateX, y: 0 },
      }
    : undefined;
  $: viewport = spendingChartViewport(
    rows.length,
    plotWidth,
    currentTransformScale,
    currentTransformTranslateX,
  );
  $: renderWindow = hasTransform
    ? spendingChartRenderWindow(rows.length, viewport)
    : rows.length > 0 ? { startIndex: 0, endIndex: rows.length } : null;
  $: renderedRows = renderWindow
    ? rows.slice(renderWindow.startIndex, renderWindow.endIndex)
    : [];
  $: shortDateFormatter = new Intl.DateTimeFormat($locale, kind === "month"
    ? { year: "2-digit", month: "2-digit", timeZone: "UTC" }
    : { month: "numeric", day: "numeric", timeZone: "UTC" }
  );
  $: longDateFormatter = new Intl.DateTimeFormat($locale, kind === "month"
    ? { year: "numeric", month: "long", timeZone: "UTC" }
    : { month: "long", day: "numeric", timeZone: "UTC" }
  );
  $: visibleRange = viewport
    ? $t.spending.chartVisibleRange(
        dateLabel(rowKey(rows[viewport.startIndex]), false),
        dateLabel(rowKey(rows[viewport.endIndex]), false),
      )
    : "";
  $: selectedCategorySet = new Set(selectedCategories);
  $: visibleCategories = SPENDING_CATEGORY_IDS.filter(
    (category) => selectedCategories.length === 0 || selectedCategorySet.has(category),
  );
  $: series = visibleCategories.map((key) => ({
    key,
    label: $t.spending.categories[key],
    color: categoryColors[key],
  }));
  $: longData = renderedRows.flatMap((row) => sources.flatMap((source) =>
    [
      ...visibleCategories.map((category) => ({
        periodKey: rowKey(row),
        source,
        category,
        value: row[source][category],
      })),
      ...(source === "account" && showPending && kind === "month"
        ? [{
            periodKey: rowKey(row),
            source,
            category: "pending" as const,
            value: pendingTotal(row, visibleCategories),
          }]
        : []),
    ]
  ));
  $: groupedData = groupStackData(longData, {
    xKey: "periodKey",
    groupBy: "source",
    stackBy: "category",
  }) as GroupStackDatum[];
  $: {
    const keys = new Set<string>();
    for (const row of renderedRows) {
      for (const source of sources) {
        if (source === "account" && showPending && kind === "month" && pendingTotal(row, visibleCategories) > 0) {
          keys.add(barKey(rowKey(row), source, "pending"));
          continue;
        }
        for (let index = visibleCategories.length - 1; index >= 0; index -= 1) {
          const category = visibleCategories[index];
          if (amountsForSource(row, source)[category] > 0) {
            keys.add(barKey(rowKey(row), source, category));
            break;
          }
        }
      }
    }
    roundedBarKeys = keys;
  }
  $: periodHitData = renderedRows.map((row) => ({
    periodKey: rowKey(row),
    source: "invoice" as const,
    category: visibleCategories[0] ?? "food",
    value: 0,
    values: [0, 0],
    keys: {},
    data: [],
  }));
  $: periodKeys = rows.map(rowKey);
  $: stackExtents = rows.flatMap((row) => sources.flatMap((source) => {
    const pending = source === "account" && showPending && kind === "month"
      ? pendingTotal(row, visibleCategories)
      : 0;
    return [
      visibleCategories.reduce((total, category) => total + Math.min(0, row[source][category]), 0)
        + Math.min(0, pending),
      visibleCategories.reduce((total, category) => total + Math.max(0, row[source][category]), 0)
        + Math.max(0, pending),
    ];
  }));
  $: yAxis = buildSparklineYAxis([0, ...stackExtents]);
  $: hasNegative = stackExtents.some((value) => value < 0);
  $: yDomain = [hasNegative ? yAxis.min : 0, yAxis.max];
  $: yTicks = yAxis.ticks.filter((tick) => hasNegative || tick >= 0);
  $: hasData = stackExtents.some((value) => value !== 0);
  $: displayLabel = label || (kind === "month" ? $t.spending.monthlyTitle : $t.spending.dailyChart);
  $: ariaLabel = selectedKey ? `${displayLabel}: ${axisLabel(selectedKey)}` : displayLabel;
  $: selectedVisible = selectedKey !== null && renderedRows.some((row) => rowKey(row) === selectedKey);
  $: compactAmount = new Intl.NumberFormat($locale, { maximumFractionDigits: 1, notation: "compact" });
  $: transformChanged = Math.abs(currentTransformScale - initialTransform.scale) > 0.001 ||
    Math.abs(currentTransformTranslateX - initialTransform.translateX) > 0.1;

  onDestroy(() => {
    if (transformFrame !== undefined) cancelAnimationFrame(transformFrame);
  });

  onMount(() => {
    const shell = stageElement.closest(".shell-page");
    const observer = new ResizeObserver(([entry]) => resizeChart(entry.contentRect.width));
    const finishSidebarResize = (event: Event) => {
      if ((event as TransitionEvent).propertyName === "grid-template-columns") commitChartWidth();
    };
    observer.observe(stageElement);
    shell?.addEventListener("transitionend", finishSidebarResize);
    return () => {
      observer.disconnect();
      shell?.removeEventListener("transitionend", finishSidebarResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  });

  function rowKey(row: SpendingChartRow) {
    return "month" in row ? row.month : row.date;
  }

  function barKey(periodKey: string, source: SpendingSource, category: SpendingStackKey) {
    return `${periodKey}:${source}:${category}`;
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

  function selectHighlight(_event: MouseEvent, detail: { data: GroupStackDatum }) {
    onBarClick?.(detail.data.periodKey);
  }

  function updateTransform(detail: TransformDetail) {
    pendingTransform = detail;
    if (transformFrame === undefined) transformFrame = requestAnimationFrame(flushTransform);
  }

  function resizeChart(width: number) {
    latestStageWidth = width;
    if (stageWidth === 0) {
      stageWidth = width;
      return;
    }
    resizeSurface.style.transform = `scaleX(${width / stageWidth})`;
    resizeSurface.style.willChange = "transform";
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(commitChartWidth, 80);
  }

  async function commitChartWidth() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = undefined;
    if (latestStageWidth > 0) stageWidth = latestStageWidth;
    await tick();
    resizeSurface.style.transform = "";
    resizeSurface.style.willChange = "";
  }

  function flushTransform() {
    if (pendingTransform) {
      transformScale = pendingTransform.scale;
      transformTranslateX = pendingTransform.translate.x;
    }
    pendingTransform = undefined;
    transformFrame = undefined;
  }

  function startTransformDrag() {
    transformDragging = true;
  }

  function endTransformDrag() {
    if (transformFrame !== undefined) cancelAnimationFrame(transformFrame);
    flushTransform();
    transformDragging = false;
  }

  function resetTransform() {
    if (transformFrame !== undefined) cancelAnimationFrame(transformFrame);
    pendingTransform = undefined;
    transformFrame = undefined;
    transformScale = undefined;
    transformTranslateX = undefined;
    chartResetKey += 1;
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
    return (short ? shortDateFormatter : longDateFormatter).format(date);
  }

  function shortAmount(value: unknown) {
    return typeof value === "number" ? compactAmount.format(value) : String(value);
  }

  function bandGeometry(
    xScale: BandScale,
    key: string,
    _transformScale: number,
    _transformTranslateX: number,
  ) {
    return {
      x: Number(xScale(key)),
      width: Number(xScale.bandwidth?.() ?? 0),
    };
  }

  function amountsForSource(row: SpendingChartRow, source: SpendingSource | "pending") {
    if (source === "pending") {
      return "pendingAccount" in row ? row.pendingAccount : emptyAmounts;
    }
    return row[source];
  }

  function sourceTotal(row: SpendingChartRow, source: SpendingSource | "pending") {
    const amounts = amountsForSource(row, source);
    return SPENDING_CATEGORY_IDS.reduce((total, category) => total + amounts[category], 0);
  }

  function pendingTotal(row: SpendingChartRow, categories: readonly SpendingCategory[]) {
    const amounts = amountsForSource(row, "pending");
    return categories.reduce((total, category) => total + amounts[category], 0);
  }

  function tooltipRow(datum: GroupStackDatum | null | undefined) {
    return datum ? rows.find((row) => rowKey(row) === datum.periodKey) : undefined;
  }

  function tooltipValue(row: SpendingChartRow | null | undefined, category: SpendingCategory) {
    return row ? row.invoice[category] + row.account[category] : 0;
  }

  function rowSummary(row: SpendingChartRow, includePending: boolean) {
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
      ...(includePending && kind === "month" ? [`${$t.spending.pendingAmount}: ${formatMoney(
        { currency: "TWD", value: sourceTotal(row, "pending") },
        { locale: $locale },
      )}`] : []),
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
  {@const selected = props.value === axisLabel(selectedKey)}
  <Text
    {...props}
    fill={selected ? "var(--fg)" : props.fill}
    font-weight={selected ? 800 : props["font-weight"]}
  />
{/snippet}

<div
  class="spending-bar-chart"
  data-chart-layout="group-stack"
  data-interaction={interaction}
  data-transform-scale={currentTransformScale}
  data-transform-translate-x={currentTransformTranslateX}
  data-initial-scale={initialTransform.scale}
  data-initial-translate-x={initialTransform.translateX}
  data-rendered-months={renderedRows.length}
  data-rendered-buckets={renderedRows.length * sources.length}
  data-show-pending={showPending && kind === "month"}
  data-rounded-bars={roundedBarKeys.size}
  data-moving={transformDragging}
  data-at-start={viewport?.atStart ?? true}
  data-at-end={viewport?.atEnd ?? true}
>
  <ul class="spending-chart-summary" aria-label={displayLabel}>
    {#each rows as row (rowKey(row))}
      <li>
        <span class="spending-row-summary">{rowSummary(row, showPending)}</span>
        {#if onBarClick}
          <button
            class="spending-row-action"
            type="button"
            aria-label={`${displayLabel}: ${rowSummary(row, showPending)}`}
            onclick={() => onBarClick?.(rowKey(row))}
          >
            {tooltipLabel(row)}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if hasData}
    <div
      class="spending-bar-stage"
      class:dragging={transformDragging}
      role="img"
      aria-label={ariaLabel}
      bind:this={stageElement}
    >
      {#if stageWidth > 0}
        <div
          class="spending-chart-resize-surface"
          bind:this={resizeSurface}
          style:width={`${stageWidth}px`}
        >
        {#key chartResetKey}
        <Chart
          width={stageWidth}
          data={groupedData}
          x="periodKey"
          xDomain={periodKeys}
          y="values"
          x1="source"
          x1Domain={sources}
          x1Range={({ xScale }) => [0, xScale.bandwidth?.() ?? 0]}
          c="category"
          cDomain={[...visibleCategories, ...(showPending && kind === "month" ? ["pending" as const] : [])]}
          cRange={[
            ...visibleCategories.map((category) => categoryColors[category]),
            ...(showPending && kind === "month" ? ["var(--warn)"] : []),
          ]}
          brush={interactionProps.brush}
          transform={chartTransform}
          onTransform={updateTransform}
          ondragstart={startTransformDrag}
          ondragend={endTransformDrag}
          {yDomain}
          yBaseline={0}
          yNice={false}
          bandPadding={kind === "month" ? 0.42 : 0.5}
          groupPadding={0.12}
          tooltipContext={{ mode: "band", onclick: selectHighlight }}
          padding={{ top: 16, right: 16, bottom: 36, left: 58 }}
          height={320}
        >
          {#snippet children({ context })}
            <Layer type="svg" zIndex={0}>
              {#if selectedKey && selectedVisible}
                {@const selectedBand = bandGeometry(
                  context.xScale,
                  selectedKey,
                  currentTransformScale,
                  currentTransformTranslateX,
                )}
                {@const selectedX = selectedBand.x}
                {@const selectedWidth = selectedBand.width}
                {#if Number.isFinite(selectedX) && selectedWidth > 0}
                  <Rect
                    data-selected-period={selectedKey}
                    x={selectedX}
                    y={0}
                    width={selectedWidth}
                    height={context.height}
                    fill="color-mix(in oklch, var(--fg) 6%, transparent)"
                    pointer-events="none"
                  />
                {/if}
              {/if}
            </Layer>
            <Layer
              type="canvas"
              zIndex={1}
              pointerEvents={false}
              disableHitCanvas
              data-spending-bars-canvas
            >
              <CanvasChartClipPath>
                {#each groupedData as datum (datum.periodKey + datum.source + datum.category)}
                  <Bar
                    data={datum}
                    fill={datum.category === "pending"
                      ? "color-mix(in oklch, var(--warn) 18%, transparent)"
                      : categoryColors[datum.category]}
                    stroke={datum.category === "pending" ? "none" : "var(--surface)"}
                    strokeWidth={datum.category === "pending" ? 0 : 1}
                    radius={roundedBarKeys.has(barKey(datum.periodKey, datum.source, datum.category)) ? 5 : 0}
                    rounded="top"
                  />
                {/each}
              </CanvasChartClipPath>
            </Layer>
            <Layer type="svg" zIndex={2} pointerEvents={false}>
              <Axis
                placement="left"
                grid={{ class: "sparkline-grid" }}
                rule
                classes={{ root: "sparkline-axis" }}
                format={shortAmount}
                ticks={yTicks}
                tickLabelProps={{ "data-sensitive": "" }}
              />
              <Axis
                placement="bottom"
                rule
                classes={{ root: "sparkline-axis" }}
                format={axisLabel}
                ticks={periodKeys}
                tickLabel={xTick}
                tickSpacing={kind === "month" ? 52 : 40}
              />
              <Highlight area={{ fill: "color-mix(in oklch, var(--fg) 5%, transparent)" }} />
            </Layer>
            <Layer type="svg" zIndex={3}>
              <SvgChartClipPath>
                {#each periodHitData as datum (datum.periodKey)}
                  {@const hitBand = bandGeometry(
                    context.xScale,
                    datum.periodKey,
                    currentTransformScale,
                    currentTransformTranslateX,
                  )}
                  <rect
                    data-period-hit={datum.periodKey}
                    role="button"
                    tabindex="0"
                    aria-label={axisLabel(datum.periodKey)}
                    x={hitBand.x}
                    y={0}
                    width={hitBand.width}
                    height={context.height}
                    fill="transparent"
                    onpointerenter={(event) => context.tooltip.show(event, datum)}
                    onpointermove={(event) => context.tooltip.show(event, datum)}
                    onpointerleave={() => context.tooltip.hide()}
                    onclick={() => onBarClick?.(datum.periodKey)}
                    onkeydown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onBarClick?.(datum.periodKey);
                      }
                    }}
                  />
                {/each}
              </SvgChartClipPath>
            </Layer>

            <Tooltip.Root {context} class="sparkline-tooltip" variant="none">
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
                  {#if showPending && kind === "month"}
                    <div class="spending-tooltip-row spending-tooltip-pending">
                      <span>{$t.spending.pendingAmount}</span>
                      <strong data-sensitive>{formatMoney(
                        { currency: "TWD", value: row ? sourceTotal(row, "pending") : 0 },
                        { locale: $locale },
                      )}</strong>
                    </div>
                  {/if}
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
        </Chart>
        {/key}
        </div>
      {/if}
      {#if hasTransform && transformDragging && visibleRange}
        <span class="spending-visible-range" data-visible-range>{visibleRange}</span>
      {/if}
      {#if hasTransform && viewport && !viewport.atStart}
        <span class="spending-chart-edge spending-chart-edge-left" aria-hidden="true"></span>
      {/if}
      {#if hasTransform && viewport && !viewport.atEnd}
        <span class="spending-chart-edge spending-chart-edge-right" aria-hidden="true"></span>
      {/if}
    </div>

  {:else}
    <div class="spending-bar-stage spending-chart-empty" role="img" aria-label={ariaLabel}>
      {$t.spending.noChartData}
    </div>
  {/if}

  {#if hasTransform}
    <div class="spending-navigation-hint">
      <span>{$t.spending.chartDragHint}</span>
      {#if transformChanged}
        <button type="button" data-action="reset" onclick={resetTransform}>
          {$t.spending.chartReset}
        </button>
      {/if}
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
      {#if showPending && kind === "month"}
        <span class="spending-legend-item spending-pending-key">
          <span class="spending-legend-swatch"></span>
          <span class="spending-legend-label">{$t.spending.pendingAmount}</span>
        </span>
      {/if}
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
    position: relative;
    width: 100%;
    height: 320px;
    overflow: hidden;
  }

  .spending-chart-resize-surface {
    height: 100%;
    transform-origin: left top;
  }

  .spending-bar-chart[data-interaction="pan-zoom"] .spending-bar-stage {
    cursor: grab;
  }

  .spending-bar-chart[data-interaction="pan-zoom"] .spending-bar-stage.dragging {
    cursor: grabbing;
  }

  .spending-bar-chart[data-interaction="static"] .spending-bar-stage,
  .spending-bar-chart[data-interaction="brush"] .spending-bar-stage {
    cursor: pointer;
  }

  :global([data-period-hit]:focus-visible) {
    fill: color-mix(in oklch, var(--accent) 8%, transparent);
    stroke: var(--accent);
    stroke-width: 2;
  }

  .spending-visible-range {
    position: absolute;
    z-index: 4;
    top: 10px;
    left: 50%;
    padding: 5px 9px;
    border-radius: var(--radius-pill);
    background: color-mix(in oklch, var(--fg) 92%, transparent);
    color: var(--surface);
    font-size: 11px;
    font-weight: 700;
    pointer-events: none;
    transform: translateX(-50%);
  }

  .spending-chart-edge {
    position: absolute;
    z-index: 3;
    top: 0;
    bottom: 0;
    width: 64px;
    pointer-events: none;
  }

  .spending-chart-edge-left {
    left: 0;
    background: linear-gradient(90deg, var(--surface), transparent);
  }

  .spending-chart-edge-right {
    right: 0;
    background: linear-gradient(-90deg, var(--surface), transparent);
  }

  .spending-navigation-hint {
    min-height: 32px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: 2px 20px 0;
    color: var(--muted);
    font-size: 11px;
  }

  .spending-navigation-hint button {
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .spending-navigation-hint button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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

  .spending-tooltip-pending {
    color: var(--warn);
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

  .spending-pending-key {
    opacity: 1;
  }

  .spending-pending-key .spending-legend-swatch {
    border: 1px solid var(--warn);
    background: color-mix(in oklch, var(--warn) 18%, transparent);
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
