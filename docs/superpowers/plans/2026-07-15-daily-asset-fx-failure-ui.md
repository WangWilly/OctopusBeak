# Daily Asset FX Failure UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing exchange rates legible in Overview's Daily asset changes panel, replace an unusable currency selector only when no row can be converted, and disable misleading amount sorting whenever any row lacks a required rate.

**Architecture:** Keep conversion state in the existing `exchange-rate-display.ts` module and derive complete absence from a TWD conversion, because every other display currency requires at least the same source rates. Keep presentation in `OverviewDashboard.svelte` and `DailyHistoryTable.svelte`; reuse the existing money formatters, converting their separator to a newline only for missing-rate rows.

**Tech Stack:** Svelte 5 compatibility syntax, TypeScript, Node built-in test runner, existing CSS custom properties; no new dependencies.

## Global Constraints

- Scope is only Overview → Daily asset changes; other summaries, pages, account details, and native-currency views must not change.
- Partial rate availability keeps the display-currency selector.
- Complete rate absence replaces the selector with `缺少匯率・顯示原幣`.
- A TWD-only dataset shows neither a redundant selector nor a missing-rate warning.
- Missing rows display one native currency per line and expose visible text rather than a tooltip-only exclamation mark.
- Date sorting always works; if any row lacks a required rate, all four amount sorts are disabled for the full dataset.
- If missing data appears while an amount sort is active, reset to Date descending.
- Do not add a dependency or refactor unrelated consumers of `DailyHistoryTable`.

---

### Task 1: Replace an unusable display-currency selector

**Files:**
- Modify: `src/lib/overview/exchange-rate-display.ts`
- Modify: `src/lib/overview/exchange-rate-display.check.ts`
- Modify: `src/lib/overview/OverviewDashboard.svelte`
- Create: `src/lib/overview/OverviewDashboard.check.ts`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: `convertDailyHistoryRows(rows, rates, "TWD").rows` and `dailyHistoryCurrencies(rows)`.
- Produces: `allExchangeRatesMissing(rows: DailyHistoryRowDto[]): boolean` and the `overview.exchangeRatesMissingNative` translation key.

- [ ] **Step 1: Write failing checks for complete absence and selector replacement**

Add `allExchangeRatesMissing` to the import in `src/lib/overview/exchange-rate-display.check.ts`, then add these assertions after the existing `missing` conversion assertions:

```ts
assert.equal(allExchangeRatesMissing([]), false);
assert.equal(allExchangeRatesMissing(converted.rows), false);
assert.equal(allExchangeRatesMissing(missing.rows), true);
assert.equal(allExchangeRatesMissing([...converted.rows, ...missing.rows]), false);
```

Create `src/lib/overview/OverviewDashboard.check.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./OverviewDashboard.svelte", import.meta.url), "utf8");

test("daily FX selector is replaced only when every TWD conversion fails", () => {
  assert.match(
    source,
    /\$: twdDailyHistory = convertDailyHistoryRows\(\s*history,\s*overview\.exchangeRates,\s*"TWD",\s*\)\.rows;/,
  );
  assert.match(
    source,
    /\$: allDailyRatesMissing = allExchangeRatesMissing\(twdDailyHistory\);/,
  );
  assert.match(
    source,
    /\{#if allDailyRatesMissing\}[\s\S]*exchangeRatesMissingNative[\s\S]*\{:else if dailyCurrencies\.length > 1\}[\s\S]*daily-base-currency/,
  );
});
```

- [ ] **Step 2: Run the focused checks and confirm they fail**

Run:

```bash
node --no-warnings --experimental-strip-types --test \
  src/lib/overview/exchange-rate-display.check.ts \
  src/lib/overview/OverviewDashboard.check.ts
```

Expected: FAIL because `allExchangeRatesMissing` is not exported and the dashboard does not yet contain the fallback state.

- [ ] **Step 3: Add the minimum availability helper**

Add this exported function to `src/lib/overview/exchange-rate-display.ts`:

```ts
export function allExchangeRatesMissing(rows: DailyHistoryRowDto[]) {
  return rows.length > 0 && rows.every((row) => row.exchangeRateMissing === true);
}
```

This intentionally treats an empty dataset as not missing and a mixed dataset as partial availability.

- [ ] **Step 4: Derive availability from TWD conversion and render one header control**

Add `allExchangeRatesMissing` to the existing import from `$lib/overview/exchange-rate-display.ts` in `OverviewDashboard.svelte`.

Immediately after `convertedDailyHistory`, add:

```ts
$: twdDailyHistory = convertDailyHistoryRows(
  history,
  overview.exchangeRates,
  "TWD",
).rows;
$: allDailyRatesMissing = allExchangeRatesMissing(twdDailyHistory);
```

Replace the current unconditional Daily asset changes selector with:

```svelte
{#if allDailyRatesMissing}
  <span class="chip missing-rate-status" role="status">
    {$t.overview.exchangeRatesMissingNative}
  </span>
{:else if dailyCurrencies.length > 1}
  <label class="chip select-chip" for="daily-base-currency">
    {$t.common.base}
    <select
      id="daily-base-currency"
      aria-label={$t.overview.dailyAssetChangesBaseCurrency}
      value={dailyCurrency}
      onchange={selectDailyCurrency}
    >
      {#each dailyCurrencies as currency}
        <option value={currency}>{currency}</option>
      {/each}
    </select>
  </label>
{/if}
```

Add this local style to `OverviewDashboard.svelte`:

```css
.missing-rate-status {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 28%, var(--border));
  background: color-mix(in oklch, var(--danger) 9%, white);
}
```

- [ ] **Step 5: Add localized visible copy**

Add to the English `overview` dictionary in `src/lib/i18n/i18n.ts`:

```ts
exchangeRatesMissingNative: "Missing exchange rates · showing native currencies",
```

Add the corresponding Traditional Chinese entry:

```ts
exchangeRatesMissingNative: "缺少匯率・顯示原幣",
```

- [ ] **Step 6: Run focused checks and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types --test \
  src/lib/overview/exchange-rate-display.check.ts \
  src/lib/overview/OverviewDashboard.check.ts
npm run typecheck
```

Expected: both focused checks PASS; typecheck reports zero errors.

- [ ] **Step 7: Commit the header-state change**

```bash
git add \
  src/lib/overview/exchange-rate-display.ts \
  src/lib/overview/exchange-rate-display.check.ts \
  src/lib/overview/OverviewDashboard.svelte \
  src/lib/overview/OverviewDashboard.check.ts \
  src/lib/i18n/i18n.ts
git commit -m "fix: clarify missing exchange-rate state"
```

---

### Task 2: Stack native currencies and disable amount sorting

**Files:**
- Modify: `src/lib/overview/components/DailyHistoryTable.svelte`
- Modify: `src/lib/overview/components/DailyHistoryTable.check.ts`

**Interfaces:**
- Consumes: `DailyHistoryRowDto.exchangeRateMissing`, the existing `formatAmountLines`, `formatSignedAmountLines`, and `historyTable.missingExchangeRate` copy.
- Produces: full-dataset `hasMissingRates` state; Date-only sorting during missing-rate states; newline-separated native money text for missing rows.

- [ ] **Step 1: Write failing source checks for stacked rows and disabled sorting**

Append these tests to `src/lib/overview/components/DailyHistoryTable.check.ts`:

```ts
test("missing exchange rates stack native currencies with visible copy", () => {
  assert.match(source, /\.replaceAll\(" \/ ", "\\n"\)/);
  assert.match(source, /<tr class:missing-rate-row=\{row\.exchangeRateMissing\}>/);
  assert.match(source, /class="rate-note missing"[\s\S]*\{\$t\.historyTable\.missingExchangeRate\}[\s\S]*<\/span>/);
  assert.match(source, /\.missing-rate-row \.money \{[\s\S]*white-space: pre-line;/);
});

test("any missing exchange rate disables all amount sorting", () => {
  assert.match(source, /\$: hasMissingRates = rows\.some\(\(row\) => row\.exchangeRateMissing === true\);/);
  assert.match(source, /if \(hasMissingRates && sortKey !== "date"\)/);
  assert.match(source, /sortDisabled = column\.key !== "date" && hasMissingRates/);
  assert.match(source, /disabled=\{sortDisabled\}/);
});
```

- [ ] **Step 2: Run the focused check and confirm it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test \
  src/lib/overview/components/DailyHistoryTable.check.ts
```

Expected: FAIL because missing rows are still slash-separated and amount sort buttons are still enabled.

- [ ] **Step 3: Derive the full-dataset missing state and reset invalid sorting**

Add these reactive statements after the existing `columns` reactive block in `DailyHistoryTable.svelte`:

```ts
$: hasMissingRates = rows.some((row) => row.exchangeRateMissing === true);
$: if (hasMissingRates && sortKey !== "date") {
  sortKey = "date";
  sortDirection = "desc";
  page = 0;
}
```

Add a guard at the start of `toggleSort`:

```ts
if (key !== "date" && hasMissingRates) return;
```

- [ ] **Step 4: Disable amount sort buttons with native semantics**

Inside `{#each columns as column}`, declare and apply the disabled state:

```svelte
{@const sortDisabled = column.key !== "date" && hasMissingRates}
<th
  class:right={column.right}
  aria-sort={!sortDisabled && sortKey === column.key
    ? (sortDirection === "asc" ? "ascending" : "descending")
    : "none"}
>
  <button
    class="sort-button"
    class:right={column.right}
    class:sorted={!sortDisabled && sortKey === column.key}
    type="button"
    disabled={sortDisabled}
    onclick={() => toggleSort(column.key)}
  >
    <span>{column.label}</span>
    <span
      class:active={!sortDisabled && sortKey === column.key}
      class:asc={!sortDisabled && sortKey === column.key && sortDirection === "asc"}
      class="sort-mark"
      aria-hidden="true"
    ></span>
  </button>
</th>
```

Replace the current hover selector and add disabled styling:

```css
.sort-button:not(:disabled):hover,
.sort-button:not(:disabled):focus-visible,
.sort-button.sorted {
  color: var(--fg);
  background: var(--surface-soft);
  outline: none;
}

.sort-button:disabled {
  cursor: not-allowed;
  color: var(--muted);
  background: transparent;
}

.sort-button:disabled .sort-mark {
  display: none;
}
```

- [ ] **Step 5: Stack missing native currencies and replace the exclamation mark**

Change the missing branch of `formatCurrencyAmount` to:

```ts
if (row.exchangeRateMissing) {
  const formatted = signed ? formatSignedAmountLines(amounts) : formatAmountLines(amounts);
  return formatted.replaceAll(" / ", "\n");
}
```

Mark each table row:

```svelte
<tr class:missing-rate-row={row.exchangeRateMissing}>
```

Replace the missing-rate `!` element with visible text:

```svelte
<span class="rate-note missing">
  {$t.historyTable.missingExchangeRate}
</span>
```

Add these styles and retain the existing converted-row styles:

```css
.missing-rate-row td {
  height: auto;
  padding-top: var(--space-4);
  padding-bottom: var(--space-4);
  vertical-align: top;
}

.missing-rate-row .money {
  white-space: pre-line;
  line-height: 1.65;
}

.rate-note.missing {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: var(--space-2) 0 0;
  padding: 3px 7px;
  border: 1px solid color-mix(in oklch, var(--danger) 28%, var(--border));
  border-radius: 999px;
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 9%, white);
  white-space: normal;
}
```

- [ ] **Step 6: Run focused checks, full tests, and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types --test \
  src/lib/overview/components/DailyHistoryTable.check.ts
npm test
npm run typecheck
```

Expected: focused check PASS; full test suite PASS; typecheck reports zero errors.

- [ ] **Step 7: Verify both availability states in Electron**

Run the existing desktop development command:

```bash
npm run desktop:dev
```

Verify in Overview → Daily asset changes:

1. With a mixed dataset, the selector remains; only missing dates show the visible native-currency badge and stacked values.
2. With every TWD conversion missing, `缺少匯率・顯示原幣` replaces the selector.
3. In either dataset containing a missing row, only Date has an enabled sort button; clicking Date still reverses chronological order.
4. With no missing rows, all amount sort buttons return and sort using the selected display currency.
5. At the current display scale, no currency text overlaps Daily change, Assets, or Liabilities.

- [ ] **Step 8: Commit the table-state change**

```bash
git add \
  src/lib/overview/components/DailyHistoryTable.svelte \
  src/lib/overview/components/DailyHistoryTable.check.ts
git commit -m "fix: make missing FX history legible"
```

---

## Final Verification

Run once after both task commits:

```bash
git diff --check HEAD~2..HEAD
npm test
npm run typecheck
```

Expected: no whitespace errors, all tests pass, and typecheck reports zero errors.
