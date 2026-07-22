# Auto-scaled Trend Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make balance and overview trend lines use their visible data range while retaining an explicit, visually broken zero reference on the overview's signed chart.

**Architecture:** Keep LayerChart as the scale and mark renderer. Add a small pure axis helper that gives ordinary trend charts tight padded domains and gives the signed overview a bounded symmetric domain around its actual extrema; render the zero reference as an explicit annotation beside the chart rather than pretending it is at a scale-correct position.

**Tech Stack:** Svelte 5, TypeScript, LayerChart 2, Node's built-in assertion test runner.

## Global Constraints

- Do not add dependencies or modify `SpendingBarChart.svelte`.
- Keep the existing X-axis domain transform, tooltips, legend selection, and exact money tooltips.
- Do not add a user-facing auto-scale notice.
- A zero annotation must visually state that the intervening range is omitted.

---

### Task 1: Define tight trend-axis ranges

**Files:**
- Modify: `src/lib/overview/components/sparkline-format.ts`
- Test: `src/lib/overview/components/sparkline-format.check.ts`

**Interfaces:**
- Produces: `buildTrendYAxis(values: number[])` returning `{ min, max, step, ticks }` for finite values, with 12% data-range headroom and a stable fallback for a flat series.

- [ ] **Step 1: Write the failing test**

```ts
import { buildTrendYAxis } from "./sparkline-format.ts";

assert.deepEqual(buildTrendYAxis([100, 120]), {
  min: 97.6,
  max: 122.4,
  step: 6.2,
  ticks: [97.6, 103.8, 110, 116.2, 122.4],
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/overview/components/sparkline-format.check.ts`

Expected: FAIL because `buildTrendYAxis` is not exported.

- [ ] **Step 3: Write the minimal implementation**

```ts
export function buildTrendYAxis(values: number[]) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { min: 0, max: 0, step: 0, ticks: [] };
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const pad = min === max ? fallbackAxisStep(min) * 2 : (max - min) * 0.12;
  const domainMin = min - pad;
  const domainMax = max + pad;
  const step = (domainMax - domainMin) / 4;
  return { min: domainMin, max: domainMax, step, ticks: [domainMin, domainMin + step, domainMin + step * 2, domainMin + step * 3, domainMax] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/overview/components/sparkline-format.check.ts`

Expected: PASS.

### Task 2: Apply the range to balance trends

**Files:**
- Modify: `src/lib/shared-accounts/components/StackedBalanceChart.svelte:3-40,80-112`
- Test: `src/lib/shared-accounts/components/StackedBalanceChart.check.ts`

**Interfaces:**
- Consumes: `buildTrendYAxis(values)` from Task 1.
- Produces: a stacked balance chart whose Y domain and tick list are calculated from `visibleChart.totals`, including after legend selection.

- [ ] **Step 1: Write the failing source-level test**

```ts
assert.match(source, /buildTrendYAxis\(visibleChart\.totals\.map\(\(point\) => point\.value\)\)/);
assert.match(source, /yDomain = \[yAxis\.min, yAxis\.max\];/);
assert.match(source, /yBaseline=\{null\}/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/shared-accounts/components/StackedBalanceChart.check.ts`

Expected: FAIL because the component still includes `0` in its domain and fixes `yBaseline` at zero.

- [ ] **Step 3: Write the minimal implementation**

```svelte
$: yAxis = buildTrendYAxis(visibleChart.totals.map((point) => point.value));
$: yDomain = [yAxis.min, yAxis.max];
$: yTicks = yAxis.ticks;

<AreaChart {yDomain} yBaseline={null} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/shared-accounts/components/StackedBalanceChart.check.ts`

Expected: PASS.

### Task 3: Make the overview signed trend readable without a zero baseline

**Files:**
- Modify: `src/lib/overview/components/SnapshotSparkline.svelte:16,51,113-162,235-312`
- Test: `src/lib/overview/components/SnapshotSparkline.check.ts`

**Interfaces:**
- Consumes: `buildTrendYAxis(values)` from Task 1.
- Produces: a diverging overview chart using the actual visible-data domain, with a static `0` + ellipsis reference labelled as an omitted range.

- [ ] **Step 1: Write the failing source-level test**

```ts
assert.match(source, /buildTrendYAxis\(chartPoints\.map\(\(point\) => point\.value\)\)/);
assert.match(source, /class="snapshot-zero-break"/);
assert.match(source, /aria-label="Zero reference; range omitted"/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/overview/components/SnapshotSparkline.check.ts`

Expected: FAIL because the overview uses `buildCenteredSparklineYAxis` and does not render a zero-break marker.

- [ ] **Step 3: Write the minimal implementation**

```svelte
$: yAxis = buildTrendYAxis(chartPoints.map((point) => point.value));

<span class="snapshot-zero-break" aria-label="Zero reference; range omitted">
  <span>0</span><span aria-hidden="true">⋮</span>
</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/overview/components/SnapshotSparkline.check.ts`

Expected: PASS.

### Task 4: Verify the focused checks and type-check

**Files:**
- Test: `src/lib/overview/components/sparkline-format.check.ts`
- Test: `src/lib/overview/components/SnapshotSparkline.check.ts`
- Test: `src/lib/shared-accounts/components/StackedBalanceChart.check.ts`

- [ ] **Step 1: Run focused regression checks**

Run: `npm test -- src/lib/overview/components/sparkline-format.check.ts src/lib/overview/components/SnapshotSparkline.check.ts src/lib/shared-accounts/components/StackedBalanceChart.check.ts`

Expected: PASS.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck`

Expected: exits 0.
