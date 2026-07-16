<script lang="ts">
  import { BarChart } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type { MonthlySpendingRow } from "$lib/spending/model.ts";
  import SpendingBarChart from "./SpendingBarChart.svelte";

  type Concept = "overview" | "timeline" | "focus-context";
  type OverviewRow = MonthlySpendingRow & { invoiceTotal: number; accountTotal: number };

  const categoryColors: Record<SpendingCategory, string> = {
    food: "var(--spending-food)",
    daily: "var(--spending-daily)",
    transport: "var(--spending-transport)",
    shopping: "var(--spending-shopping)",
    home: "var(--spending-home)",
    leisure: "var(--spending-leisure)",
    other: "var(--spending-other)",
  };
  const concepts = [
    { id: "overview", label: "A · Overview + drilldown" },
    { id: "timeline", label: "B · Horizontal timeline" },
    { id: "focus-context", label: "C · Focus + context" },
  ] as const;
  const sourceSeries = [
    { key: "invoiceTotal", label: "E-invoice", color: "var(--spending-food)" },
    { key: "accountTotal", label: "Account", color: "var(--spending-other)" },
  ];

  export let rows: readonly MonthlySpendingRow[] = [];
  export let selectedKey: string | null = null;
  export let onBarClick: ((month: string) => void) | null = null;

  let concept: Concept = "overview";
  let localSelectedKey: string | null = null;
  const focusSize = 8;
  let focusStart = Math.max(0, rows.length - focusSize);

  $: overviewRows = rows.map((row) => ({
    ...row,
    invoiceTotal: sourceTotal(row, "invoice"),
    accountTotal: sourceTotal(row, "account"),
  }));
  $: maxFocusStart = Math.max(0, rows.length - Math.min(focusSize, rows.length));
  $: focusStart = Math.min(maxFocusStart, Math.max(0, Number(focusStart) || 0));
  $: focusRows = rows.slice(focusStart, focusStart + focusSize);
  $: activeKey = localSelectedKey ?? selectedKey ?? rows.at(-1)?.month ?? null;
  $: activeRow = rows.find((row) => row.month === activeKey) ?? rows.at(-1);
  $: focusBrush = {
    axis: "x" as const,
    x: focusRows.length > 0 ? [focusRows[0].month, focusRows.at(-1)?.month ?? focusRows[0].month] : [],
    minExtent: { x: Math.min(focusSize, rows.length) },
    maxExtent: { x: Math.min(focusSize, rows.length) },
    clickToReset: false,
    zoomOnBrush: false,
    onChange: updateFocusFromBrush,
  };

  function sourceTotal(row: MonthlySpendingRow, source: "invoice" | "account") {
    return SPENDING_CATEGORY_IDS.reduce((total, category) => total + row[source][category], 0);
  }

  function categoryTotal(row: MonthlySpendingRow | undefined, category: SpendingCategory) {
    return row ? row.invoice[category] + row.account[category] : 0;
  }

  function selectMonth(month: string) {
    localSelectedKey = month;
    onBarClick?.(month);
  }

  function selectOverviewBar(_event: MouseEvent, detail: { data: OverviewRow }) {
    selectMonth(detail.data.month);
  }

  function updateFocusFromBrush(detail: { brush: { x: Array<number | Date | string | null> } }) {
    const first = String(detail.brush.x[0] ?? "");
    const index = rows.findIndex((row) => row.month === first);
    if (index >= 0 && index !== focusStart) focusStart = Math.min(index, maxFocusStart);
  }

  function moveFocus(delta: number) {
    focusStart = Math.min(maxFocusStart, Math.max(0, focusStart + delta));
  }

  function monthLabel(month: string | undefined) {
    if (!month) return "";
    const [year, monthNumber] = month.split("-").map(Number);
    return year && monthNumber
      ? new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, monthNumber - 1, 1)))
      : month;
  }

  function shortMonth(value: unknown) {
    const [year, month] = String(value).split("-");
    return year && month ? `${month}/${year.slice(-2)}` : String(value);
  }
</script>

<div class="chart-alternatives" data-chart-concept={concept} data-focus-start={focusStart}>
  <div class="concept-selector" role="group" aria-label="Monthly chart design">
    {#each concepts as option}
      <button
        type="button"
        data-concept-option={option.id}
        aria-pressed={concept === option.id}
        onclick={() => concept = option.id}
      >{option.label}</button>
    {/each}
  </div>

  {#if concept === "overview"}
    <div class="overview-layout">
      <div class="overview-chart" aria-label="Full-history spending overview">
        <BarChart
          data={overviewRows}
          x="month"
          series={sourceSeries}
          seriesLayout="group"
          axis={true}
          grid={{ y: true }}
          legend={false}
          height={300}
          padding={{ top: 18, right: 12, bottom: 42, left: 54 }}
          bandPadding={0.45}
          onBarClick={selectOverviewBar}
          props={{
            bars: { radius: 6 },
            grid: { class: "sparkline-grid" },
            xAxis: { class: "sparkline-axis", format: shortMonth, tickSpacing: 58 },
            yAxis: { class: "sparkline-axis" },
          }}
        />
      </div>
      <aside class="overview-detail" data-overview-detail aria-live="polite">
        <div>
          <span>Selected month</span>
          <strong>{monthLabel(activeRow?.month)}</strong>
        </div>
        <strong class="detail-total" data-sensitive>{formatMoney(
          { currency: "TWD", value: activeRow?.total ?? 0 },
          { locale: $locale },
        )}</strong>
        <ul>
          {#each SPENDING_CATEGORY_IDS as category}
            <li>
              <span class="category-name"><i style:background={categoryColors[category]}></i>{$t.spending.categories[category]}</span>
              <strong data-sensitive>{formatMoney(
                { currency: "TWD", value: categoryTotal(activeRow, category) },
                { locale: $locale },
              )}</strong>
            </li>
          {/each}
        </ul>
      </aside>
    </div>
  {:else if concept === "timeline"}
    <p class="concept-note">Drag the chart to move through time. Zoom to keep every month readable.</p>
    <SpendingBarChart
      {rows}
      kind="month"
      interaction="pan-zoom"
      {selectedKey}
      onBarClick={selectMonth}
    />
  {:else}
    <div class="context-chart" aria-label="Full-history range selector">
      <BarChart
        data={overviewRows}
        x="month"
        y="total"
        brush={focusBrush}
        axis="x"
        grid={false}
        legend={false}
        height={124}
        padding={{ top: 10, right: 12, bottom: 30, left: 12 }}
        bandPadding={0.35}
        props={{
          bars: { fill: "var(--spending-other)", opacity: 0.5, radius: 3 },
          xAxis: { class: "sparkline-axis", format: shortMonth, tickSpacing: 74 },
        }}
      />
    </div>
    <div class="focus-controls">
      <button type="button" onclick={() => moveFocus(-1)} disabled={focusStart === 0}>Earlier</button>
      <label>
        <span>Visible range</span>
        <input type="range" min="0" max={maxFocusStart} step="1" bind:value={focusStart} />
      </label>
      <button type="button" onclick={() => moveFocus(1)} disabled={focusStart === maxFocusStart}>Later</button>
    </div>
    <SpendingBarChart rows={focusRows} kind="month" {selectedKey} onBarClick={selectMonth} />
  {/if}
</div>

<style>
  .chart-alternatives { min-width: 0; }

  .concept-selector {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 0 var(--space-4);
    overflow-x: auto;
  }

  .concept-selector button,
  .focus-controls button {
    min-height: 34px;
    padding: 6px 11px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .concept-selector button[aria-pressed="true"] {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--surface);
  }

  button:focus-visible,
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .overview-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 0.28fr);
    gap: var(--space-5);
  }

  .overview-chart,
  .context-chart { min-width: 0; }

  .overview-detail {
    align-self: stretch;
    display: grid;
    align-content: start;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-soft);
  }

  .overview-detail > div { display: grid; gap: 2px; }
  .overview-detail span { color: var(--muted); font-size: 11px; }
  .overview-detail strong { font-size: 13px; }
  .detail-total { font-size: 20px !important; font-variant-numeric: tabular-nums; }
  .overview-detail ul { display: grid; gap: 8px; margin: 0; padding: 10px 0 0; border-top: 1px solid var(--border); list-style: none; }
  .overview-detail li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .category-name { display: inline-flex; align-items: center; gap: 7px; }
  .category-name i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 99px; }

  .concept-note { margin: 0 16px 4px; color: var(--muted); font-size: 12px; }

  .context-chart {
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-soft);
  }

  .context-chart :global(.lc-brush-range) { background: color-mix(in oklch, var(--accent) 16%, transparent); border: 2px solid var(--accent); }
  .context-chart :global(.lc-brush-handle) { background: var(--accent); }

  .focus-controls {
    display: grid;
    grid-template-columns: auto minmax(160px, 1fr) auto;
    align-items: end;
    gap: var(--space-3);
    padding: var(--space-3) 16px 0;
  }

  .focus-controls label { display: grid; gap: 5px; color: var(--muted); font-size: 11px; text-align: center; }
  .focus-controls input { width: 100%; accent-color: var(--accent); }
  .focus-controls button:disabled { opacity: 0.4; }

  @media (max-width: 760px) {
    .concept-selector { justify-content: flex-start; }
    .overview-layout { grid-template-columns: 1fr; }
    .overview-detail { grid-template-columns: 1fr auto; }
    .overview-detail ul { grid-column: 1 / -1; }
    .focus-controls { grid-template-columns: 1fr 1fr; }
    .focus-controls label { grid-column: 1 / -1; grid-row: 1; }
  }
</style>
