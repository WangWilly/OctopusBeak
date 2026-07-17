# Spending Drag Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Spending Group/Stack chart responsive while preserving direct drag, wheel zoom, tooltip, selection, and category filtering.

**Architecture:** Continue using `groupStackData` and LayerChart `Bar`, but render the 280 bar marks in one Canvas layer. Keep the selection band, axes, and Highlight in separate SVG layers so text and selection remain crisp; allow pointer events to pass through the top SVG layer to LayerChart's Canvas hit-testing.

**Tech Stack:** Svelte 5, TypeScript, LayerChart Canvas/SVG layers, Playwright, Electron CDP.

## Global Constraints

- Keep LayerChart `groupStackData`, `Chart`, `Bar`, `Highlight`, and `Tooltip`.
- Keep direct pointer drag, Command/Control + wheel zoom, reset, category filtering, and month selection.
- Keep the existing 20-month virtualized render window and full x-domain.
- Do not add dependencies, backend pagination, caching, custom drawing code, or animation.
- Do not mutate ledger data during verification.

---

### Task 1: Move grouped bars to LayerChart Canvas

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`

**Interfaces:**
- Consumes: existing `groupedData: GroupStackDatum[]` and LayerChart layer context.
- Produces: one `canvas[data-spending-bars-canvas]`, SVG selection/axis/highlight layers, and unchanged tooltip/click callbacks.

- [x] **Step 1: Add the failing browser assertions**

Require one Canvas bar layer, at least one SVG layer, one selected-period band, no DOM bar nodes, and the existing 20-month/40-bucket bounds:

```js
assert.equal(await chart.locator('canvas[data-spending-bars-canvas]').count(), 1);
assert.equal(await chart.locator('canvas.lc-layout-canvas').count(), 1);
assert.equal(await chart.locator('svg.lc-layout-svg').count() > 0, true);
assert.equal(await chart.locator('[data-selected-period]').count(), 1);
assert.equal(await chart.locator('[data-spending-bar]').count(), 0);
assert.equal(await chart.getAttribute('data-rendered-months'), '20');
assert.equal(await chart.getAttribute('data-rendered-buckets'), '40');
```

- [x] **Step 2: Run the focused check and verify RED**

Run `node scripts/spending-chart-alternatives.check.mjs`.

Expected: FAIL with Canvas count `0 !== 1`.

- [x] **Step 3: Split bars and overlays into native LayerChart layers**

Render the selected-period `Rect` in an SVG layer at z-index 0, render all `Bar` components in a Canvas layer at z-index 1, and render axes plus `Highlight` in an SVG layer at z-index 2 with `pointerEvents={false}`. Keep `tooltip` and `onclick` on each Canvas Bar so LayerChart's hit canvas preserves hover and month selection.

- [x] **Step 4: Run the focused check and verify GREEN**

Run `node scripts/spending-chart-alternatives.check.mjs`.

Expected: exit 0; Canvas, drag, reset, tooltip click, selection, and virtualization assertions pass.

### Task 2: Verify performance and desktop behavior

**Files:**
- No production files beyond Task 1.

**Interfaces:**
- Consumes: the Canvas/SVG hybrid chart.
- Produces: measured performance evidence and live Electron UI verification.

- [x] **Step 1: Run type and build checks**

Run `npm run typecheck` and `npm run build`.

Expected: zero Svelte errors/warnings and successful renderer/Electron builds.

- [x] **Step 2: Repeat the baseline 90-step drag through Electron CDP**

Record `spending.load` calls, requestAnimationFrame p50/p95/max, ScriptDuration, LayoutDuration, DOM nodes, and rendered months.

Expected: zero load calls, p95 below 33 ms, ScriptDuration materially lower than the 13.19-second SVG baseline, and no change to the 20-month bound.

- [x] **Step 3: Verify live interactions and visuals**

Through Electron CDP, confirm direct drag changes translate, Command/Control + wheel changes scale, reset restores the initial scale, one selected background stays aligned behind the bars, and the renderer console has no errors. Capture `/tmp/spending-canvas-bars.png` for visual inspection.

- [x] **Step 4: Run the complete repository checks**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0.

### Task 3: Align selection and month hit areas

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`

- [x] Make selected-band geometry explicitly depend on LayerChart transform state.
- [x] Wrap Canvas Bars with LayerChart `ChartClipPath` so overscan never paints into the axes.
- [x] Add one clipped, transparent, keyboard-accessible SVG hit band per rendered month.
- [x] Disable the redundant 280-Bar Canvas hit-canvas after month bands own hover and click.
- [x] Verify a zero-value month can be selected and shows the tooltip.
- [x] Verify the selected band changes x during drag.
- [x] Verify painted Canvas pixels stay inside the 58 px left and 16 px right plot padding.
