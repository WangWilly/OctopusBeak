# Snapshot Area Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the visible area beneath positive overview-history lines and above the liabilities line.

**Architecture:** `SnapshotSparkline` already uses LayerChart `AreaChart`. A reactive `areaBaseline` selects `0` for all or multi-series views, the lower visible domain edge for a selected positive series, and the upper visible domain edge for liabilities. The existing area element then renders its series colour with low opacity.

**Tech Stack:** Svelte, LayerChart `AreaChart`, Node assert checks.

## Global Constraints

- Reuse LayerChart's existing `yBaseline`; add no dependency or component.
- Preserve current Y-axis brushing, automatic ticks, and single-series trend domains.
- Do not alter bar-chart rendering. Stacked balance charts may receive compatible tooltip and axis-format fixes.

---

### Task 1: Add visible overview area fill

**Files:**
- Modify: `src/lib/overview/components/SnapshotSparkline.svelte:63-166,305-308`
- Test: `src/lib/overview/components/SnapshotSparkline.check.ts`

**Interfaces:**
- Consumes: `selectedSeriesKeys`, `yAxis.min`, `yAxis.max`, and LayerChart's `yBaseline` prop.
- Produces: `areaBaseline: number`, supplied to the diverging `AreaChart`.

- [ ] **Step 1: Write the failing test**

```ts
assert.match(source, /areaBaseline = selectedSeriesKeys\.length === 1\s*\? selectedSeriesKeys\[0\] === "liabilities" \? yAxis\.max : yAxis\.min\s*:\s*0/);
assert.match(source, /yBaseline=\{areaBaseline\}/);
assert.match(source, /fill-opacity:\s*0\.14;/);
assert.doesNotMatch(source, /\.snapshot-diverging-area\s*\{[^}]*opacity:\s*0;/);
```

- [ ] **Step 2: Run the check and verify it fails**

Run: `node --no-warnings --experimental-strip-types --test src/lib/overview/components/SnapshotSparkline.check.ts`

Expected: fail because `areaBaseline` and the visible fill style do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
$: areaBaseline = selectedSeriesKeys.length === 1
  ? selectedSeriesKeys[0] === "liabilities" ? yAxis.max : yAxis.min
  : 0;
```

```svelte
<AreaChart yBaseline={areaBaseline} />
```

```css
:global(.snapshot-diverging-area) {
  fill-opacity: 0.14;
}
```

- [ ] **Step 4: Run focused verification**

Run: `node --no-warnings --experimental-strip-types --test src/lib/overview/components/SnapshotSparkline.check.ts && npm run typecheck && npm run build`

Expected: source check passes; Svelte reports zero errors and warnings; renderer and Electron builds succeed.

- [ ] **Step 5: Verify the desktop chart**

Run: reload the Electron overview through CDP, select `資產`, then `負債`.

Expected: asset fill reaches the bottom visible edge, liability fill reaches the top visible edge, and the Y-axis range remains trend-scaled for each one.
