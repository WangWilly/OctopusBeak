# Spending Chart Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep direct grab-and-glide navigation while reducing monthly-chart render work from the full SVG history to a Canvas viewport with overscan.

**Architecture:** Preserve the full categorical x-domain, compute an 18-month initial viewport, and pass only visible rows plus two months of overscan to LayerChart. Use LayerChart's installed Canvas primitives and coalesce transform feedback to one Svelte update per animation frame.

**Tech Stack:** Svelte 5, TypeScript, LayerChart 2 Canvas renderer, Node assert checks, Playwright, Electron CDP.

## Global Constraints

- Do not add dependencies.
- Do not restore range buttons or the rejected chart selector.
- Keep every month in the accessible hidden summary.
- Do not change the database loader; measured loading is not the drag bottleneck.
- Work in the current `codex/account-spending` checkout because the user declined a worktree.

---

### Task 1: Viewport render window

**Files:**
- Modify: `src/lib/spending/components/spending-chart-window.check.ts`
- Modify: `src/lib/spending/components/spending-chart-window.ts`

**Interfaces:**
- Consumes: `SpendingChartViewport` from `spending-chart-interaction.ts`.
- Produces: `SPENDING_CHART_VISIBLE_MONTHS`, `spendingChartInitialTransform()`, and `spendingChartRenderWindow()`.

- [ ] **Step 1: Replace the old range-option checks with failing viewport checks**

```ts
assert.deepEqual(spendingChartInitialTransform(30, 1000), {
  scale: 30 / 18,
  translateX: 1000 - 1000 * (30 / 18),
});
assert.deepEqual(spendingChartRenderWindow(30, {
  startIndex: 12,
  endIndex: 29,
  atStart: false,
  atEnd: true,
}), { startIndex: 10, endIndex: 30 });
assert.deepEqual(spendingChartRenderWindow(30, {
  startIndex: 5,
  endIndex: 14,
  atStart: false,
  atEnd: false,
}), { startIndex: 3, endIndex: 17 });
assert.equal(spendingChartRenderWindow(0, null), null);
```

- [ ] **Step 2: Run the focused check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the minimum range helpers**

```ts
import type { SpendingChartViewport } from "./spending-chart-interaction.ts";

export const SPENDING_CHART_VISIBLE_MONTHS = 18;
export const SPENDING_CHART_OVERSCAN = 2;

export function spendingChartInitialTransform(rowCount: number, width: number) {
  const scale = Math.max(1, rowCount / SPENDING_CHART_VISIBLE_MONTHS);
  return { scale, translateX: width > 0 ? width - width * scale : 0 };
}

export function spendingChartRenderWindow(
  rowCount: number,
  viewport: SpendingChartViewport | null,
) {
  if (rowCount <= 0 || !viewport) return null;
  return {
    startIndex: Math.max(0, viewport.startIndex - SPENDING_CHART_OVERSCAN),
    endIndex: Math.min(rowCount, viewport.endIndex + 1 + SPENDING_CHART_OVERSCAN),
  };
}
```

- [ ] **Step 4: Run the focused check and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts`

Expected: exit 0.

- [ ] **Step 5: Commit the helper and check**

```bash
git add src/lib/spending/components/spending-chart-window.ts src/lib/spending/components/spending-chart-window.check.ts
git commit -m "feat: virtualize spending chart months"
```

### Task 2: Canvas chart and coalesced transform feedback

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`

**Interfaces:**
- Consumes: `spendingChartInitialTransform()` and `spendingChartRenderWindow()` from Task 1.
- Produces: a Canvas monthly chart with `data-rendered-months`, `data-rendered-buckets`, `data-initial-scale`, and existing interaction attributes.

- [ ] **Step 1: Make the browser check require Canvas and virtualization**

Change the fixture to 30 months and assert:

```js
assert.equal(await chart.locator("canvas.lc-layout-canvas").count(), 1);
assert.equal(await chart.locator(".spending-bar-segment").count(), 0);
assert.equal(await chart.getAttribute("data-rendered-months"), "20");
assert.equal(await chart.getAttribute("data-rendered-buckets"), "40");
assert.ok(Number(await chart.getAttribute("data-initial-scale")) > 1);
```

Drag right without zooming first, assert translation changes and `window.__spendingLoadCount` does not. Reset to `data-initial-scale`, then locate a tooltip by moving across the canvas and click it to verify month selection.

- [ ] **Step 2: Run the browser check and verify RED**

Run: `node scripts/spending-chart-alternatives.check.mjs`

Expected: FAIL because the chart still renders SVG and all months.

- [ ] **Step 3: Switch the chart primitives and virtualize buckets**

Use:

```ts
import { BarChart, Rect, Text, type BarChartProps, type TextProps } from "layerchart/canvas";
import { Tooltip } from "layerchart";
```

Derive the full x-domain from all rows, derive the render window from the coalesced viewport, slice rows only for `buckets`, and pass `xDomain={fullBucketKeys}` to `BarChart`. Replace the selected raw SVG `<rect>` with Canvas `<Rect>`.

- [ ] **Step 4: Coalesce transform feedback and reuse formatters**

Use one pending transform and one animation frame:

```ts
let pendingTransform: { scale: number; translate: { x: number; y: number } } | undefined;
let transformFrame: number | undefined;

function updateTransform(detail: typeof pendingTransform) {
  pendingTransform = detail;
  if (transformFrame !== undefined) return;
  transformFrame = requestAnimationFrame(flushTransform);
}

function flushTransform() {
  if (pendingTransform) {
    transformScale = pendingTransform.scale;
    transformTranslateX = pendingTransform.translate.x;
  }
  pendingTransform = undefined;
  transformFrame = undefined;
}
```

Cancel the frame in `onDestroy`. Construct short and long `Intl.DateTimeFormat` instances reactively from locale and chart kind, then reuse them in `dateLabel()`.

- [ ] **Step 5: Run browser, focused, type, and build checks**

Run:

```bash
node scripts/spending-chart-alternatives.check.mjs
node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-interaction.check.ts
npm run typecheck
npm run build
```

Expected: all exit 0.

- [ ] **Step 6: Commit the Canvas implementation**

```bash
git add scripts/spending-chart-alternatives.check.mjs src/lib/spending/components/SpendingBarChart.svelte
git commit -m "perf: smooth spending chart navigation"
```

### Task 3: Electron and full-suite verification

**Files:**
- No production files expected.

**Interfaces:**
- Consumes: the completed chart from Task 2.
- Produces: measured Electron evidence and a passing repository state.

- [ ] **Step 1: Inspect the live Spending route through CDP**

Confirm the route is `#/spending`, the monthly chart contains one Canvas, `data-rendered-months` is below the full 30-month count at the initial view, and direct drag changes translation without a console error.

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 143 or more tests pass, zero failures, zero Svelte/type errors, successful renderer/Electron builds, and no whitespace errors.
