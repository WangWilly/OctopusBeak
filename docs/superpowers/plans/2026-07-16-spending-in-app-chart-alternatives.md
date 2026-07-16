# Spending In-App Chart Alternatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the approved Overview + Drilldown, Horizontal Timeline, and Focus + Context prototypes inside the current App Spending page using real Spending data and LayerChart.

**Architecture:** Add one `SpendingChartAlternatives` component that owns the temporary A/B/C selector. It uses LayerChart directly for the overview/context charts and reuses `SpendingBarChart` for stacked-category detail; `SpendingDashboard` only passes its existing monthly rows and month callback.

**Tech Stack:** Svelte 5, SvelteKit, `layerchart@^2.0.0`, Playwright.

## Global Constraints

- Render inside the existing Spending monthly panel; do not keep a separate study route.
- Use `model.monthlyRows` and the existing month-selection callback.
- A is Overview + Drilldown, B is Horizontal Timeline, C is Focus + Context.
- Remove the 6/12/24 segmented range control from this prototype.
- Add no dependencies and preserve the rest of the Spending page.

---

### Task 1: Build the in-app alternatives component

**Files:**
- Create: `src/lib/spending/components/SpendingChartAlternatives.svelte`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`
- Modify: `src/lib/spending/SpendingDashboard.svelte`

**Interfaces:**
- Consumes: `rows: readonly MonthlySpendingRow[]`, `selectedKey: string | null`, `onBarClick: (month: string) => void`.
- Produces: `[data-chart-concept="overview"]`, `[data-chart-concept="timeline"]`, and `[data-chart-concept="focus-context"]` inside the existing monthly panel.

- [ ] **Step 1: Write a failing browser check for the current Spending route**

Update `scripts/spending-chart-alternatives.check.mjs` to inject a minimal `window.octopusBeak` Spending model, open `/#/spending`, and assert the three prototype selector buttons exist inside `.monthly-panel`; verify the current page fails before implementation.

- [ ] **Step 2: Implement `SpendingChartAlternatives`**

Use one native button group to switch concepts. Render:

```svelte
{#if concept === "overview"}
  <BarChart data={overviewRows} x="month" series={sourceSeries} seriesLayout="group" onBarClick={selectOverviewBar} />
  <aside>{selectedMonthCategoryBreakdown}</aside>
{:else if concept === "timeline"}
  <SpendingBarChart {rows} interaction="pan-zoom" {selectedKey} {onBarClick} />
{:else}
  <BarChart data={overviewRows} x="month" y="total" brush={focusBrush} />
  <input type="range" min="0" max={Math.max(0, rows.length - focusSize)} bind:value={focusStart} />
  <SpendingBarChart rows={focusRows} {selectedKey} {onBarClick} />
{/if}
```

The overview side panel lists the selected month's seven category totals with their existing Spending colors and formatted TWD values.

Use LayerChart brush domain values to update `focusStart`; keep the native range input as the keyboard fallback.

- [ ] **Step 3: Wire the component into `SpendingDashboard`**

Remove `SPENDING_CHART_RANGE_OPTIONS`, `chartRange`, and `monthlyChartRows`. Replace the current monthly `<SpendingBarChart>` with:

```svelte
<SpendingChartAlternatives
  rows={model.monthlyRows}
  selectedKey={selectedMonth ?? model.selectedMonth}
  onBarClick={(month) => void selectMonth(month)}
/>
```

- [ ] **Step 4: Add previous/next transform controls**

Extend the existing LayerChart transform toolbar with `pan-left` and `pan-right` buttons that call `chartContext.transform.setTranslate()` using 20% of the current chart width. Keep Zoom in, Zoom out, and Reset.

- [ ] **Step 5: Run checks**

Run: `npm run typecheck`

Expected: `svelte-check found 0 errors and 0 warnings`.

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: the Spending route renders the selector and all three concepts; timeline zoom and focus range updates pass.

### Task 2: Remove the incorrect standalone study

**Files:**
- Delete: `src/routes/spending-chart-study/+page.svelte`
- Modify: `scripts/spending-chart-alternatives.check.mjs`

- [ ] **Step 1: Delete the separate route and make the smoke check target only `/#/spending`**

- [ ] **Step 2: Run full verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build:renderer`

Expected: build passes and no `/spending-chart-study` route is emitted.
