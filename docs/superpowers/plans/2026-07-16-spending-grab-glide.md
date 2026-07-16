# Spending Grab-and-Glide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Spending page's temporary chart alternatives with one direct-manipulation monthly chart that pans by drag and zooms only with the platform modifier key.

**Architecture:** Reuse `SpendingBarChart` and its existing LayerChart domain transform. Keep transform math in the existing interaction helper so transient visible-range and boundary feedback can be checked without mounting Svelte; wire the full monthly dataset directly from `SpendingDashboard` and delete the temporary alternatives component.

**Tech Stack:** Svelte 5, TypeScript, LayerChart 2, Node assertions, Playwright.

## Global Constraints

- Remove the 6/12/24 month controls and the temporary A/B/C concept selector.
- Use LayerChart domain transform on the x axis with `scrollActivationKey: "meta"` and `scaleExtent: [1, 6]`.
- Preserve stacked category bars, source pairing, tooltips, legend filtering, selected-month highlighting, bar click selection, and the lower month toolbar.
- Keep only a zoomed-state reset action; do not add a permanent pan/zoom toolbar, brush, timeline rail, central lens, or dependency.
- Panning and zooming change chart presentation only and never reload Spending data.
- Keep unrelated dirty-worktree changes out of every commit.

---

### Task 1: Derive viewport feedback from the existing transform

**Files:**
- Modify: `src/lib/spending/components/spending-chart-interaction.ts:1-24`
- Modify: `src/lib/spending/components/spending-chart-interaction.check.ts:1-29`

**Interfaces:**
- Consumes: `rowCount: number`, `width: number`, `scale: number`, and `translateX: number` from LayerChart transform state.
- Produces: `spendingChartViewport(rowCount, width, scale, translateX): { startIndex: number; endIndex: number; atStart: boolean; atEnd: boolean } | null`.

- [ ] **Step 1: Add failing viewport assertions**

Append these assertions before the existing transform-prop assertions:

```ts
import {
  spendingChartInteractionProps,
  spendingChartViewport,
} from "./spending-chart-interaction.ts";

assert.equal(spendingChartViewport(0, 1000, 1, 0), null);
assert.deepEqual(spendingChartViewport(24, 1000, 1, 0), {
  startIndex: 0,
  endIndex: 23,
  atStart: true,
  atEnd: true,
});
assert.deepEqual(spendingChartViewport(24, 1000, 2, 0), {
  startIndex: 0,
  endIndex: 11,
  atStart: true,
  atEnd: false,
});
assert.deepEqual(spendingChartViewport(24, 1000, 2, -1000), {
  startIndex: 12,
  endIndex: 23,
  atStart: false,
  atEnd: true,
});
```

- [ ] **Step 2: Run the focused check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-interaction.check.ts
```

Expected: FAIL because `spendingChartViewport` is not exported.

- [ ] **Step 3: Implement the smallest transform-to-row calculation**

Add to `spending-chart-interaction.ts`:

```ts
export type SpendingChartViewport = {
  startIndex: number;
  endIndex: number;
  atStart: boolean;
  atEnd: boolean;
};

export function spendingChartViewport(
  rowCount: number,
  width: number,
  scale: number,
  translateX: number,
): SpendingChartViewport | null {
  if (rowCount <= 0 || width <= 0) return null;
  const scaledWidth = width * Math.max(1, scale);
  const startIndex = Math.min(rowCount - 1, Math.floor(Math.max(0, -translateX) / scaledWidth * rowCount));
  const endIndex = Math.min(
    rowCount - 1,
    Math.max(startIndex, Math.ceil(Math.min(width, width - translateX) / scaledWidth * rowCount) - 1),
  );
  return { startIndex, endIndex, atStart: startIndex === 0, atEnd: endIndex === rowCount - 1 };
}
```

- [ ] **Step 4: Run the focused check and verify GREEN**

Run the command from Step 2.

Expected: exit 0 with no output.

- [ ] **Step 5: Commit the helper and check**

```bash
git add src/lib/spending/components/spending-chart-interaction.ts src/lib/spending/components/spending-chart-interaction.check.ts
git commit -m "test: define spending chart viewport feedback"
```

### Task 2: Localize direct-manipulation feedback

**Files:**
- Modify: `src/lib/i18n/i18n.check.ts:24-31`
- Modify: `src/lib/i18n/i18n.ts:99-119,534-554`

**Interfaces:**
- Produces: `spending.chartDragHint`, `spending.chartVisibleRange(start, end)`, and `spending.chartReset` in English and Traditional Chinese.

- [ ] **Step 1: Add failing translation assertions**

Add:

```ts
assert.equal(translations.en.spending.chartDragHint, "Drag to browse · Command/Control + scroll to zoom");
assert.equal(translations["zh-TW"].spending.chartDragHint, "拖曳瀏覽 · Command／Control＋滾輪縮放");
assert.equal(translations.en.spending.chartVisibleRange("Jan 2026", "Dec 2026"), "Visible: Jan 2026–Dec 2026");
assert.equal(translations["zh-TW"].spending.chartVisibleRange("2026年1月", "2026年12月"), "目前顯示：2026年1月–2026年12月");
assert.equal(translations.en.spending.chartReset, "Reset view");
assert.equal(translations["zh-TW"].spending.chartReset, "重設檢視");
```

- [ ] **Step 2: Run the i18n check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: FAIL because the three translation entries do not exist.

- [ ] **Step 3: Add only the approved strings**

Add to both `spending` translation objects:

```ts
// English
chartDragHint: "Drag to browse · Command/Control + scroll to zoom",
chartVisibleRange: (start: string, end: string) => `Visible: ${start}–${end}`,
chartReset: "Reset view",

// Traditional Chinese
chartDragHint: "拖曳瀏覽 · Command／Control＋滾輪縮放",
chartVisibleRange: (start, end) => `目前顯示：${start}–${end}`,
chartReset: "重設檢視",
```

- [ ] **Step 4: Run the i18n check and verify GREEN**

Run the command from Step 2.

Expected: exit 0 with no output.

- [ ] **Step 5: Commit the translations**

```bash
git add src/lib/i18n/i18n.ts src/lib/i18n/i18n.check.ts
git commit -m "feat: localize spending chart navigation"
```

### Task 3: Promote Grab and Glide into the Spending page

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs:1-104`
- Modify: `src/lib/spending/SpendingDashboard.svelte:1-18,306-328`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte:1-554`
- Delete: `src/lib/spending/components/SpendingChartAlternatives.svelte`

**Interfaces:**
- Consumes: all `model.monthlyRows`, `selectedMonth ?? model.selectedMonth`, `spendingChartViewport(...)`, and existing `selectMonth(month)`.
- Produces: one `[data-interaction="pan-zoom"]` chart with `data-transform-scale`, `data-transform-translate-x`, `data-at-start`, `data-at-end`, a transient `[data-visible-range]`, and a zoom-only `[data-action="reset"]`.

- [ ] **Step 1: Replace the alternatives smoke assertions with failing Grab-and-Glide assertions**

Keep the existing Vite server, 24-month model, console-error capture, and `window.octopusBeak` stub. Replace the prototype assertions after navigation with:

```js
const chart = page.locator('.monthly-panel [data-interaction="pan-zoom"]');
await chart.waitFor();
assert.equal(await page.locator(".monthly-panel [data-chart-concept]").count(), 0);
assert.equal(await page.locator(".monthly-panel [data-concept-option]").count(), 0);
assert.equal(await chart.locator('[data-action="pan-left"], [data-action="pan-right"], [data-action="zoom-in"], [data-action="zoom-out"]').count(), 0);
assert.equal(await chart.locator('[data-action="reset"]').count(), 0);
assert.equal(await chart.getAttribute("data-at-start"), "true");
assert.equal(await chart.getAttribute("data-at-end"), "true");

await chart.locator(".spending-bar-stage").dispatchEvent("wheel", { deltaY: -600, metaKey: true });
await page.waitForFunction(() => Number(document.querySelector('[data-interaction="pan-zoom"]')?.getAttribute("data-transform-scale")) > 1);
assert.equal(await chart.locator('[data-action="reset"]').count(), 1);

const stage = chart.locator(".spending-bar-stage");
const box = await stage.boundingBox();
assert.ok(box);
await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5, { steps: 8 });
assert.equal(await chart.getAttribute("data-moving"), "true");
assert.equal(await chart.locator("[data-visible-range]").count(), 1);
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('[data-interaction="pan-zoom"]')?.getAttribute("data-moving") === "false");
assert.notEqual(await chart.getAttribute("data-transform-translate-x"), "0");
assert.deepEqual(errors, []);
```

- [ ] **Step 2: Run the browser check and verify RED**

Run:

```bash
node scripts/spending-chart-alternatives.check.mjs
```

Expected: FAIL because the current page still renders the concept selector and permanent transform toolbar.

- [ ] **Step 3: Wire the approved chart directly into `SpendingDashboard`**

Replace the alternatives import with:

```ts
import SpendingBarChart from "./components/SpendingBarChart.svelte";
```

Replace `<SpendingChartAlternatives ... />` with:

```svelte
<SpendingBarChart
  rows={model.monthlyRows}
  kind="month"
  interaction="pan-zoom"
  selectedKey={selectedMonth ?? model.selectedMonth}
  onBarClick={(month) => void selectMonth(month)}
/>
```

- [ ] **Step 4: Replace the permanent transform toolbar with transient feedback**

In `SpendingBarChart.svelte`:

```ts
import {
  spendingChartInteractionProps,
  spendingChartViewport,
  type SpendingChartInteraction,
} from "./spending-chart-interaction.ts";

let transformScale = 1;
let transformTranslateX = 0;
$: transformMoving = Boolean(chartContext?.transform.moving);
$: viewport = spendingChartViewport(rows.length, stageWidth, transformScale, transformTranslateX);
$: visibleRange = viewport
  ? $t.spending.chartVisibleRange(
      dateLabel(rowKey(rows[viewport.startIndex]), false),
      dateLabel(rowKey(rows[viewport.endIndex]), false),
    )
  : "";

function updateTransform(detail: { scale: number; translate: { x: number; y: number } }) {
  transformScale = detail.scale;
  transformTranslateX = detail.translate.x;
}
```

Add `data-transform-translate-x`, `data-moving`, `data-at-start`, and `data-at-end` to `.spending-bar-chart`. Remove `panChart()` and the permanent five-button toolbar. Inside `.spending-bar-stage`, render:

```svelte
{#if hasTransform && transformMoving && visibleRange}
  <span class="spending-visible-range" data-visible-range>{visibleRange}</span>
{/if}
{#if hasTransform && viewport && !viewport.atStart}
  <span class="spending-chart-edge spending-chart-edge-left" aria-hidden="true"></span>
{/if}
{#if hasTransform && viewport && !viewport.atEnd}
  <span class="spending-chart-edge spending-chart-edge-right" aria-hidden="true"></span>
{/if}
```

After the stage, render the text hint and a reset action only while zoomed:

```svelte
{#if hasTransform}
  <div class="spending-navigation-hint">
    <span>{$t.spending.chartDragHint}</span>
    {#if transformScale > 1}
      <button type="button" data-action="reset" onclick={() => chartContext?.transform.reset()}>
        {$t.spending.chartReset}
      </button>
    {/if}
  </div>
{/if}
```

Use existing color, border, radius, and focus tokens. Set grab/grabbing cursors on the stage, position the range label over the chart, and use pointer-events-free linear-gradient edge fades. Disable feedback transitions under `prefers-reduced-motion: reduce`.

- [ ] **Step 5: Delete the temporary alternatives component**

Delete `src/lib/spending/components/SpendingChartAlternatives.svelte`. Confirm no production import or selector remains:

```bash
rg -n "SpendingChartAlternatives|data-chart-concept|data-concept-option" src
```

Expected: no matches.

- [ ] **Step 6: Run the browser check and focused checks**

Run:

```bash
node scripts/spending-chart-alternatives.check.mjs
node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-interaction.check.ts
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
```

Expected: all exit 0 with no console errors.

- [ ] **Step 7: Run full verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: typecheck reports 0 errors and warnings, build exits 0, and diff check exits 0.

- [ ] **Step 8: Commit the promoted design**

```bash
git add scripts/spending-chart-alternatives.check.mjs src/lib/spending/SpendingDashboard.svelte src/lib/spending/components/SpendingBarChart.svelte src/lib/spending/components/SpendingChartAlternatives.svelte
git commit -m "feat: promote grab-and-glide spending chart"
```
