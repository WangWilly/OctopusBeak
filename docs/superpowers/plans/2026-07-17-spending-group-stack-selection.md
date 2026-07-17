# Spending Grouped + Stacked Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each spending period as two source groups with category stacks and replace the drifting selection outline with an approved full-period background band.

**Architecture:** Keep the existing `SpendingBarChart` public API, transform state, bounded render window, and accessibility summary. Convert the visible rows to LayerChart long data, pass it through `groupStackData`, then compose `Chart`, `Layer`, `Axis`, `Bar`, `Highlight`, and `Tooltip`; selection is one period-scale rectangle behind the marks.

**Tech Stack:** Svelte 5, TypeScript, LayerChart 2, D3 band scales, Node test runner, Electron browser interaction check.

## Global Constraints

- Preserve the existing visible-window rendering and overscan.
- Preserve the full period domain, requestAnimationFrame-coalesced transform updates, tooltip content, category filtering, source order, click behavior, and accessible summaries.
- Render the selected band only when its period is in the current render window.
- Add no dependency and no new component abstraction.

---

### Task 1: Lock grouped stacks and selection band in the browser check

**Files:**
- Modify: `scripts/spending-chart-alternatives.check.mjs`

**Interfaces:**
- Consumes: the existing Spending-page browser fixture and `.spending-bar-chart` diagnostics.
- Produces: assertions for `data-chart-layout="group-stack"`, source/category bar attributes, and `data-selected-period`.

- [ ] **Step 1: Write the failing assertions**

Add assertions after the chart is visible:

```js
assert.equal(await page.locator('.spending-bar-chart').getAttribute('data-chart-layout'), 'group-stack');
assert.equal(await page.locator('[data-spending-bar][data-source="invoice"]').count() > 0, true);
assert.equal(await page.locator('[data-spending-bar][data-source="account"]').count() > 0, true);
assert.equal(await page.locator('[data-selected-period]').count(), 1);
assert.equal(await page.locator('[data-selection-outline]').count(), 0);
```

- [ ] **Step 2: Run the check and verify RED**

Run:

```bash
node --test scripts/spending-chart-alternatives.check.mjs
```

Expected: FAIL because `data-chart-layout` and the selected-period band do not exist.

- [ ] **Step 3: Commit the failing check with Task 2's implementation**

Keep this RED change unstaged until the implementation passes so the commit remains buildable.

---

### Task 2: Compose the chart with LayerChart group + stack

**Files:**
- Modify: `src/lib/spending/components/SpendingBarChart.svelte`
- Test: `scripts/spending-chart-alternatives.check.mjs`

**Interfaces:**
- Consumes: `rows`, `renderedRows`, `visibleCategories`, transform state, and the existing callbacks.
- Produces: long records `{ periodKey, source, category, value }`, grouped stack records from `groupStackData`, and the unchanged `SpendingBarChart` component API.

- [ ] **Step 1: Replace high-level Canvas imports with compositional LayerChart imports**

```ts
import { Axis, Bar, Chart, groupStackData, Highlight, Layer, Rect, Text, Tooltip, type TextProps } from "layerchart";
import { scaleBand } from "d3-scale";
```

- [ ] **Step 2: Build visible long data and grouped stack data**

```ts
type Source = "invoice" | "account";
type LongDatum = { periodKey: string; source: Source; category: SpendingCategory; value: number };
type GroupStackDatum = LongDatum & { keys: Record<string, unknown>; values: number[]; data: LongDatum[] };

$: longData = renderedRows.flatMap((row) =>
  (["invoice", "account"] as const).flatMap((source) =>
    visibleCategories.map((category) => ({
      periodKey: rowKey(row),
      source,
      category,
      value: row[source][category],
    })),
  ),
);
$: groupedStackData = groupStackData(longData, {
  xKey: "periodKey",
  groupBy: "source",
  stackBy: "category",
}) as GroupStackDatum[];
$: periodKeys = rows.map(rowKey);
```

- [ ] **Step 3: Render the period band, axes, grouped stacks, and hover highlight**

Use `Chart` with `x="periodKey"`, `y="values"`, `x1="source"`, band scales, the full `periodKeys` domain, existing y-domain/transform props, and the source order `["invoice", "account"]`.

```svelte
<Chart
  data={groupedStackData}
  x="periodKey"
  xDomain={periodKeys}
  xScale={scaleBand().paddingInner(0.42).paddingOuter(0.18)}
  y="values"
  x1="source"
  x1Domain={["invoice", "account"]}
  x1Scale={scaleBand().padding(0.12)}
  x1Range={({ xScale }) => [0, xScale.bandwidth()]}
  c="category"
  cDomain={visibleCategories}
  cRange={visibleCategories.map((category) => categoryColors[category])}
  {yDomain}
  transform={chartTransform}
  onTransform={updateTransform}
  tooltipContext={{ mode: "band" }}
  padding={{ top: 16, right: 16, bottom: 36, left: 58 }}
  height={320}
>
  {#snippet children({ context })}
    <Layer>
      <Axis placement="left" grid rule />
      <Axis placement="bottom" rule />
      {#if selectedKey && renderWindow && rows.slice(renderWindow.startIndex, renderWindow.endIndex).some((row) => rowKey(row) === selectedKey)}
        <Rect data-selected-period x={context.xScale(selectedKey)} y={0} width={context.xScale.bandwidth()} height={context.height} fill="color-mix(in oklch, var(--fg) 6%, transparent)" />
      {/if}
      {#each groupedStackData as datum (datum.periodKey + datum.source + datum.category)}
        <Bar
          data={datum}
          tooltip
          data-spending-bar
          data-period={datum.periodKey}
          data-source={datum.source}
          data-category={datum.category}
          fill={categoryColors[datum.category]}
          onclick={() => onBarClick?.(datum.periodKey)}
        />
      {/each}
      <Highlight area />
    </Layer>
  {/snippet}
</Chart>
```

Keep the existing custom tick and tooltip snippets, adapting their datum type from the old source bucket to `GroupStackDatum`.

- [ ] **Step 4: Remove obsolete outline and Canvas-only code**

Delete `selectedExtents`, the `aboveMarks` outline rectangle, bucket-key domain construction, `selectBar`, `selectTooltip`, and Canvas-only selectors. Add `data-chart-layout="group-stack"` to `.spending-bar-chart`.

- [ ] **Step 5: Run focused checks and verify GREEN**

Run:

```bash
node --test scripts/spending-chart-alternatives.check.mjs
npm run typecheck
```

Expected: browser check PASS; Svelte reports zero errors and zero warnings.

- [ ] **Step 6: Commit**

```bash
git add scripts/spending-chart-alternatives.check.mjs src/lib/spending/components/SpendingBarChart.svelte
git commit -m "feat: group and stack spending chart"
```

---

### Task 3: Visual and regression verification

**Files:**
- Create: `design-qa.md`
- Verify: `src/lib/spending/components/SpendingBarChart.svelte`

**Interfaces:**
- Consumes: the approved B visual direction and the rendered Spending route.
- Produces: a passing design-QA report and fresh regression evidence.

- [ ] **Step 1: Run the full automated verification**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 143 or more tests pass, zero typecheck errors/warnings, renderer and Electron production builds complete, and no whitespace errors.

- [ ] **Step 2: Verify the live Spending page**

Start the Electron development app, open `#/spending`, then verify:

- each period contains left invoice and right account bars;
- categories stack within each source;
- the selected period has a neutral full-slot background and no outline;
- direct drag, modified-wheel zoom, reset, tooltip, category filtering, and bar click still work;
- no console error appears.

- [ ] **Step 3: Capture and compare the implementation**

Capture the same Spending viewport as the supplied issue screenshot. Compare the grouped bars and selected-period state, record the source and implementation paths, viewport, state, findings, comparison history, and `final result: passed` in `design-qa.md`.

- [ ] **Step 4: Commit QA evidence if it contains no machine-specific secret**

```bash
git add design-qa.md
git commit -m "docs: verify grouped spending chart"
```
