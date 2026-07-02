# LayerChart Sparkline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom portfolio sparkline internals with LayerChart while keeping the existing `SnapshotSparkline.svelte` public API stable.

**Architecture:** Keep dashboard callers unchanged and isolate chart-specific data mapping in a tiny TypeScript helper. LayerChart owns line/area/axis/tooltip rendering; the app still owns DTO filtering, money formatting, labels, privacy CSS, and page-level currency selection.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript, LayerChart 2.x, Node assert checks, existing `npm run typecheck`.

---

## Scope

Implement only Phase 1 from `docs/superpowers/specs/2026-07-02-ui-library-evaluation-design.md`.

Do not add shadcn-svelte.

Do not add TanStack Table.

Do not redesign `DashboardShell.svelte`.

Before editing, run `git status --short`. This worktree currently has an unrelated unstaged `package-lock.json` change. Preserve it. If dependency installation changes `package-lock.json`, inspect the diff and stage only the dependency-related lockfile changes together with `package.json`.

## File Structure

- Modify: `package.json`
  - Add `layerchart` as a development dependency.
- Modify: `package-lock.json`
  - Let `npm install` update the lockfile for LayerChart only.
- Create: `src/lib/overview/components/snapshot-chart-data.ts`
  - Convert `DailyHistoryRowDto[]` into sorted `{ date, dateLabel, value }` points for one currency and amount key.
- Create: `src/lib/overview/components/snapshot-chart-data.check.ts`
  - Assert the mapper filters missing currencies, sorts by date, keeps date labels, and preserves negative values.
- Modify: `src/lib/overview/components/SnapshotSparkline.svelte`
  - Replace custom SVG path/axis math with LayerChart `AreaChart` and a custom tooltip snippet.
  - Keep props unchanged: `rows`, `currency`, `amountKey`, `label`.
- Modify: `src/app.css`
  - Remove unused custom SVG path/dot tooltip selectors after the Svelte file stops using them.
  - Keep `.sparkline`, `.sparkline-axis`, `.sparkline-empty`, and privacy behavior.

---

### Task 1: Add LayerChart Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm current worktree state**

Run:

```bash
git status --short
```

Expected:

```text
 M package-lock.json
```

If additional unrelated files appear, leave them unstaged. If `package-lock.json` is still dirty, run:

```bash
git diff -- package-lock.json
```

Expected: output shows the pre-existing lockfile change. Keep it in mind before staging.

- [ ] **Step 2: Install LayerChart**

Run:

```bash
npm install -D layerchart@2.0.0
```

Expected: `package.json` gains a `devDependencies.layerchart` entry and `package-lock.json` gains the LayerChart dependency tree.

- [ ] **Step 3: Verify dependency entry**

Open `package.json` and confirm the `devDependencies` block contains:

```json
"layerchart": "^2.0.0"
```

If npm writes `"2.0.0"` instead of `"^2.0.0"`, keep npm's output.

- [ ] **Step 4: Inspect the dependency diff**

Run:

```bash
git diff -- package.json package-lock.json
```

Expected: diff contains the LayerChart dependency. If the pre-existing `package-lock.json` change is mixed into the same file, do not revert it; stage the final lockfile only after confirming it is still compatible with the user's existing change.

- [ ] **Step 5: Typecheck dependency resolution**

Run:

```bash
npm run typecheck
```

Expected: PASS. No source imports LayerChart yet, but dependency resolution should not break SvelteKit sync or TypeScript.

- [ ] **Step 6: Commit dependency**

Run:

```bash
git add package.json package-lock.json
git commit -m "chore: add layerchart"
```

Expected: commit succeeds. If the lockfile had unrelated pre-existing edits, mention that in the commit body:

```bash
git commit -m "chore: add layerchart" -m "Preserves existing package-lock changes in the worktree."
```

---

### Task 2: Add Tested Snapshot Chart Data Mapper

**Files:**
- Create: `src/lib/overview/components/snapshot-chart-data.ts`
- Create: `src/lib/overview/components/snapshot-chart-data.check.ts`

- [ ] **Step 1: Write the failing check**

Create `src/lib/overview/components/snapshot-chart-data.check.ts`:

```ts
import assert from "node:assert/strict";
import { buildSnapshotChartPoints } from "./snapshot-chart-data.ts";
import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

const rows: DailyHistoryRowDto[] = [
  {
    date: "2026-07-02",
    netAssets: [{ currency: "TWD", value: 120 }],
    assets: [{ currency: "TWD", value: 160 }],
    liabilities: [{ currency: "TWD", value: 40 }],
    dailyChange: [{ currency: "TWD", value: -10 }],
  },
  {
    date: "2026-07-01",
    netAssets: [
      { currency: "TWD", value: 100 },
      { currency: "USD", value: 3 },
    ],
    assets: [{ currency: "TWD", value: 150 }],
    liabilities: [{ currency: "TWD", value: 50 }],
    dailyChange: [{ currency: "TWD", value: 5 }],
  },
  {
    date: "2026-07-03",
    netAssets: [{ currency: "USD", value: 4 }],
    assets: [{ currency: "USD", value: 4 }],
    liabilities: [],
    dailyChange: [{ currency: "USD", value: 1 }],
  },
];

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "netAssets"), [
  { date: new Date("2026-07-01T00:00:00.000Z"), dateLabel: "2026-07-01", value: 100 },
  { date: new Date("2026-07-02T00:00:00.000Z"), dateLabel: "2026-07-02", value: 120 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "dailyChange"), [
  { date: new Date("2026-07-01T00:00:00.000Z"), dateLabel: "2026-07-01", value: 5 },
  { date: new Date("2026-07-02T00:00:00.000Z"), dateLabel: "2026-07-02", value: -10 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "JPY", "netAssets"), []);
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts
```

Expected: FAIL with a module-not-found error for `snapshot-chart-data.ts`.

- [ ] **Step 3: Write the mapper**

Create `src/lib/overview/components/snapshot-chart-data.ts`:

```ts
import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

type HistoryAmountKey = "netAssets" | "assets" | "liabilities" | "dailyChange";

export type SnapshotChartPoint = {
  date: Date;
  dateLabel: string;
  value: number;
};

export function buildSnapshotChartPoints(
  rows: DailyHistoryRowDto[],
  currency: string,
  amountKey: HistoryAmountKey,
): SnapshotChartPoint[] {
  return rows
    .map((row) => {
      const amount = row[amountKey].find((item) => item.currency === currency);
      return amount
        ? {
            date: new Date(`${row.date}T00:00:00.000Z`),
            dateLabel: row.date,
            value: amount.value,
          }
        : null;
    })
    .filter((item): item is SnapshotChartPoint => item !== null)
    .sort((left, right) => left.dateLabel.localeCompare(right.dateLabel));
}
```

- [ ] **Step 4: Run check to verify it passes**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts
```

Expected: PASS with no output.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit mapper**

Run:

```bash
git add src/lib/overview/components/snapshot-chart-data.ts src/lib/overview/components/snapshot-chart-data.check.ts
git commit -m "test: cover snapshot chart data mapping"
```

Expected: commit succeeds.

---

### Task 3: Replace SnapshotSparkline Internals

**Files:**
- Modify: `src/lib/overview/components/SnapshotSparkline.svelte`
- Modify: `src/app.css`

- [ ] **Step 1: Replace `SnapshotSparkline.svelte`**

Replace the full contents of `src/lib/overview/components/SnapshotSparkline.svelte` with:

```svelte
<script lang="ts">
  import { AreaChart, Tooltip } from "layerchart";
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { buildSnapshotChartPoints } from "./snapshot-chart-data.ts";

  type HistoryAmountKey = "netAssets" | "assets" | "liabilities";

  export let rows: DailyHistoryRowDto[] = [];
  export let currency = "TWD";
  export let amountKey: HistoryAmountKey = "netAssets";
  export let label = "Net position";

  $: points = buildSnapshotChartPoints(rows, currency, amountKey);
  $: ariaLabel = `${label} trend ${currency}`;

  function shortDate(value: string) {
    return value.slice(5);
  }

  function pointTitle(point: { dateLabel: string; value: number }) {
    return `${point.dateLabel} ${formatMoney({ currency, value: point.value })}`;
  }
</script>

{#if points.length > 0}
  <div class="sparkline" role="img" aria-label={ariaLabel}>
    <AreaChart
      data={points}
      x="date"
      y="value"
      yNice
      axis="xy"
      grid="y"
      height={220}
      props={{
        area: { class: "sparkline-area" },
        line: { class: "sparkline-line" },
        axis: {
          x: { class: "sparkline-axis", format: shortDate },
          y: { class: "sparkline-axis", props: { tickLabel: { "data-sensitive": "" } } },
        },
        grid: { class: "sparkline-grid" },
        highlight: { points: { r: 5, class: "sparkline-dot" } },
      }}
    >
      {#snippet tooltip({ context })}
        <Tooltip.Root {context} class="sparkline-tooltip" variant="none">
          {#snippet children({ data })}
            <div class="sparkline-tooltip-body">
              <span>{data.dateLabel}</span>
              <strong>{formatMoney({ currency, value: data.value })}</strong>
            </div>
          {/snippet}
        </Tooltip.Root>
      {/snippet}
    </AreaChart>
    <ul class="sparkline-points" aria-hidden="true">
      {#each points as point}
        <li>{pointTitle(point)}</li>
      {/each}
    </ul>
  </div>
{:else}
  <div class="sparkline sparkline-empty" role="img" aria-label={ariaLabel}>
    No {currency} history
  </div>
{/if}
```

- [ ] **Step 2: Run typecheck to catch LayerChart API drift**

Run:

```bash
npm run typecheck
```

Expected: PASS. If this fails because LayerChart 2.0.0 prop names differ, use the installed package's TypeScript errors as the source of truth and make the smallest prop-name change that preserves the same behavior.

- [ ] **Step 3: Trim obsolete SVG-only CSS**

In `src/app.css`, replace the existing sparkline CSS block from `.sparkline { ... }` through `.sparkline-empty { ... }` with:

```css
.sparkline {
  width: 100%;
  height: 220px;
  display: block;
  margin-bottom: var(--space-4);
}

.sparkline svg {
  width: 100%;
  height: 100%;
  display: block;
}

.sparkline-grid line,
.sparkline-grid path {
  stroke: var(--border);
}

.sparkline-axis {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}

.sparkline-area {
  fill: color-mix(in oklch, var(--accent) 14%, white);
}

.sparkline-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sparkline-dot {
  fill: var(--accent);
  stroke: white;
  stroke-width: 3;
}

.sparkline-tooltip {
  pointer-events: none;
}

.sparkline-tooltip-body {
  display: grid;
  gap: 2px;
  min-width: 132px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--fg) 92%, transparent);
  color: white;
  font-size: 12px;
  font-weight: 800;
}

.sparkline-tooltip-body strong {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.sparkline-points {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.sparkline-empty {
  min-height: 220px;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
}
```

- [ ] **Step 4: Run mapper check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts
```

Expected: PASS with no output.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Start mock dev server**

Run:

```bash
npm run dev:mock
```

Expected: Vite starts and prints a local URL, usually `http://localhost:5173/`.

- [ ] **Step 7: Browser-check chart rendering**

Open the dev server URL in the browser and check these hash routes:

```text
http://localhost:5173/#/overview
http://localhost:5173/#/assets
http://localhost:5173/#/liabilities
```

Expected on each page:

- the chart area is non-empty
- x-axis dates render as `MM-DD`
- y-axis values are visible when values are shown
- the value visibility toggle still blurs sensitive chart tick values through `[data-sensitive]`
- hovering the chart shows a tooltip with date and formatted money
- the page does not horizontally overflow at desktop width

- [ ] **Step 8: Stop dev server**

Stop the Vite process with `Ctrl-C`.

Expected: the server exits cleanly.

- [ ] **Step 9: Commit chart replacement**

Run:

```bash
git add src/lib/overview/components/SnapshotSparkline.svelte src/app.css
git commit -m "feat: render snapshot charts with layerchart"
```

Expected: commit succeeds.

---

## Self-Review

Spec coverage:

- LayerChart-first rollout is covered by Tasks 1 and 3.
- Stable `SnapshotSparkline.svelte` props are covered in Task 3.
- DTO-to-chart mapping is covered in Task 2.
- Empty state, privacy behavior, typecheck, and browser visual checks are covered in Task 3.
- TanStack Table and shadcn-svelte are intentionally out of scope for this plan.

Placeholder scan:

- No task relies on unspecified files.
- Every code-writing step includes the exact file content or replacement block.
- Every verification step has an exact command and expected result.

Type consistency:

- `HistoryAmountKey` in `SnapshotSparkline.svelte` remains the existing three chart keys.
- `buildSnapshotChartPoints` supports `dailyChange` only for tests and future table/chart reuse.
- `SnapshotChartPoint.dateLabel` is used for display and sort stability; `SnapshotChartPoint.date` is used by LayerChart.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-07-02-layerchart-sparkline.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
