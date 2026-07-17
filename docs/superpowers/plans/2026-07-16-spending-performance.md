# Spending Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize zero-padded ROC dates and limit the monthly Spending chart to a selectable 6-, 12-, or 24-month window so initial render and sidebar resizing stay responsive.

**Architecture:** Keep the complete Spending model unchanged. Add one pure chart-window selector beside the chart, consume its bounded rows in `SpendingDashboard`, and fix date normalization at the shared CSV parser boundary so every downstream consumer receives Gregorian dates.

**Tech Stack:** TypeScript, Svelte 5, LayerChart, Node assertion checks, Electron CDP.

## Global Constraints

- Default monthly chart range is exactly 12 months; available ranges are exactly 6, 12, and 24 months.
- The selected month must remain inside the rendered chart window.
- Do not add dependencies, caching, database indexes, continuous zoom gestures, or unrelated data repair.
- Do not mutate the user's ledger during verification.

---

### Task 1: Normalize zero-padded ROC dates

**Files:**
- Modify: `src/ledger/source-csv-parsers.check.ts`
- Modify: `src/ledger/source-csv-parsers.ts:302-330`

**Interfaces:**
- Consumes: `createSourceCsvParser(...)`.
- Produces: existing parser fields with `0113/08/19` and `01130819` normalized to `2024-08-19`.

- [x] **Step 1: Add the failing HNCB parser assertions**

Create an HNCB statements parser and assert that separated and compact zero-padded ROC dates become Gregorian while `2025/08/19` remains unchanged.

- [x] **Step 2: Run the focused check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts`

Expected: FAIL because `0113/08/19` currently becomes `0113-08-19`.

- [x] **Step 3: Implement minimal shared year normalization**

Add a private helper that converts a four-digit year beginning with `0` by adding 1911, and use it in both the compact and separated four-digit branches of `normalizeDateValue`.

- [x] **Step 4: Run the focused check and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts`

Expected: exit 0.

### Task 2: Select a bounded monthly chart window

**Files:**
- Create: `src/lib/spending/components/spending-chart-window.ts`
- Create: `src/lib/spending/components/spending-chart-window.check.ts`

**Interfaces:**
- Produces: `SPENDING_CHART_RANGE_OPTIONS = [6, 12, 24]`, `SpendingChartRange`, and `selectMonthlyChartRows(rows, selectedMonth, range)`.

- [x] **Step 1: Add the failing pure selector check**

Use 30 minimal `MonthlySpendingRow` values and assert:

```ts
assert.deepEqual(selectMonthlyChartRows(rows, months[18], 12).map((row) => row.month), months.slice(7, 19));
assert.deepEqual(selectMonthlyChartRows(rows, months[0], 6).map((row) => row.month), months.slice(0, 6));
assert.deepEqual(selectMonthlyChartRows(rows, months.at(-1)!, 24).map((row) => row.month), months.slice(6));
```

- [x] **Step 2: Run the check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimal selector**

Find the selected row index, end the window at the selected row when possible, clamp the window to the dataset bounds, and return `rows.slice(start, end)`.

- [x] **Step 4: Run the check and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts`

Expected: exit 0.

### Task 3: Add the chart range control

**Files:**
- Modify: `src/lib/spending/SpendingDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `src/lib/i18n/i18n.check.ts`

**Interfaces:**
- Consumes: `SPENDING_CHART_RANGE_OPTIONS`, `SpendingChartRange`, and `selectMonthlyChartRows` from Task 2.
- Produces: a native 6/12/24-month button group and passes only selected chart rows to `SpendingBarChart`.

- [x] **Step 1: Add failing translation assertions**

Assert English and Traditional Chinese labels for the chart-range group and each month-count option.

- [x] **Step 2: Run the i18n check and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts`

Expected: FAIL because the chart-range translations do not exist.

- [x] **Step 3: Add minimal translations and dashboard state**

Add `chartRangeAria` and `chartRangeLabel(months)` in both locales. Initialize `chartRange` to `12`, derive `monthlyChartRows` from the current selected month, render the native range buttons, and replace `rows={model.monthlyRows}` with `rows={monthlyChartRows}`.

- [x] **Step 4: Add only the CSS needed for the compact button group**

Reuse `.filter-btn`; add layout rules for a right-aligned, non-wrapping range group and stack it below the title on compact screens.

- [x] **Step 5: Run focused checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/i18n/i18n.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/components/spending-chart-window.check.ts
```

Expected: both exit 0.

### Task 4: Verify behavior and performance

**Files:**
- Modify only files required by failures found in this task, including the shared shell if the measured fallback threshold is exceeded.

- [x] **Step 1: Run repository checks**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all exit 0.

- [x] **Step 2: Verify the live Electron page through CDP**

Start `npm run desktop:dev`, navigate to `#/spending`, and confirm the default chart has 12 row summaries and at most 168 bar segments. Select 6 and 24 months and confirm the counts update without console errors.

- [x] **Step 3: Measure sidebar collapse and expansion**

Capture long-task durations at the default 12-month range. If either direction still produces a task above 100 ms, stop and report the measurement before adding the spec's transition-end fallback.

- [x] **Step 4: Review the final diff**

Confirm only the parser, parser check, chart-window helper/check, dashboard, i18n, and measured shared-shell fallback changed. Do not re-import or mutate the default ledger.
