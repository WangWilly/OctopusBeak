# Stacked Balance Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single total balance line on Assets and Liabilities with LayerChart stacked area charts: `All Assets` / `All Debts` stack by account type, a selected type stacks by individual account, and the metric strip appears above the chart. Add a short transition when the chart data changes.

**Architecture:** Keep account history aggregation in a pure TypeScript helper, bind the existing `AccountTable` category filter up to each dashboard, and render the derived series through a reusable `StackedBalanceChart.svelte` component. The dashboards own filter/currency state and pass chart-ready series into the component.

**Tech Stack:** SvelteKit, Svelte 5, TypeScript, LayerChart `AreaChart` with `seriesLayout="stack"`, existing assert-based `*.check.ts` checks, Electron dev CDP for visual verification.

---

## Notes From Discovery

- Current dashboard files are:
  - `src/lib/assets/AssetsDashboard.svelte`
  - `src/lib/liabilities/LiabilitiesDashboard.svelte`
- Shared table filter is internal to `src/lib/shared-accounts/components/AccountTable.svelte`; expose it as a bindable prop.
- Existing sparkline helpers are in:
  - `src/lib/overview/components/SnapshotSparkline.svelte`
  - `src/lib/overview/components/snapshot-chart-data.ts`
  - `src/lib/overview/components/sparkline-format.ts`
- `DailyHistoryRowDto` only contains aggregate `assets` / `liabilities`, so allocation/exposure must be derived from `dailyHistoryByAccount` plus account metadata.
- Local LayerChart supports:
  - `series: [{ key, label, color, data }]`
  - `seriesLayout: "stack"`
  - `legend={...}`
  - `motion={{ type: "tween", duration: 180 }}`

## Implementation Tasks

- [ ] 1. Add a failing pure-data check for stacked balance series.

  Create `src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts`.

  Cover these cases:
  - `filter === "all"` on assets returns one series per asset kind, in stable order: `bank`, `fund`, `brokerage`, `crypto`, `foreign`.
  - `filter === "bank"` returns one series per bank account.
  - liabilities use stable order: `credit-card`, `loan`, `crypto`, `other`.
  - missing currency values are filled with `0` for aligned stack dates.
  - zero-only series are omitted.
  - liability values are positive exposure values, even if an upstream history row ever stores a negative debt number.

  Use a tiny fixture, not production data:

  ```ts
  import assert from "node:assert/strict";
  import type { AccountRowDto, DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { buildStackedBalanceChartData } from "./stacked-balance-chart-data.ts";

  const accounts = [
    account("bank-a", "Bank A", "bank", 100),
    account("bank-b", "Bank B", "bank", 200),
    account("fund-a", "Fund A", "fund", 300),
    account("card-a", "Card A", "credit-card", 400),
    account("loan-a", "Loan A", "loan", 500),
  ];

  const dailyHistoryByAccount = {
    "bank-a": [row("2026-06-24", 100, 0), row("2026-06-25", 110, 0)],
    "bank-b": [row("2026-06-24", 200, 0), row("2026-06-25", 220, 0)],
    "fund-a": [row("2026-06-24", 300, 0), row("2026-06-25", 330, 0)],
    "card-a": [row("2026-06-24", 0, -400), row("2026-06-25", 0, -410)],
    "loan-a": [row("2026-06-24", 0, 500), row("2026-06-25", 0, 520)],
  } satisfies Record<string, DailyHistoryRowDto[]>;
  ```

  Expected first run:

  ```bash
  node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts
  ```

  It should fail because `stacked-balance-chart-data.ts` does not exist yet.

- [ ] 2. Implement the stacked balance data helper.

  Add `src/lib/shared-accounts/components/stacked-balance-chart-data.ts`.

  Public API:

  ```ts
  import type { AccountKind, AccountRowDto, DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

  export type BalanceChartMode = "asset" | "liability";
  export type BalanceChartFilter = AccountKind | "all";

  export type StackedBalancePoint = {
    date: string;
    dateLabel: string;
    value: number;
  };

  export type StackedBalanceSeries = {
    key: string;
    label: string;
    color: string;
    data: StackedBalancePoint[];
  };

  export type StackedBalanceChartData = {
    dates: string[];
    series: StackedBalanceSeries[];
    totals: StackedBalancePoint[];
    signature: string;
  };

  export function buildStackedBalanceChartData(options: {
    accounts: AccountRowDto[];
    dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
    filter: BalanceChartFilter;
    currency: string;
    mode: BalanceChartMode;
    limit?: number;
  }): StackedBalanceChartData;
  ```

  Implementation rules:
  - Filter accounts by `mode` page input, then by `filter`.
  - When `filter === "all"`, group by `account.kind`.
  - When `filter !== "all"`, group by `account.id`.
  - Use the union of dates from selected account histories, sort ascending, and keep the last `limit ?? 30`.
  - For each group/date, sum the matching currency from `row.assets` or `row.liabilities`.
  - For liabilities, use `Math.abs(value)` per account/date before summing.
  - Drop a group when every point is effectively zero.
  - Build `totals` by summing visible series per date; the chart y-axis uses these totals.
  - Use a fixed multi-hue palette, not one shade family:

    ```ts
    const STACK_COLORS = [
      "#2563eb",
      "#059669",
      "#d97706",
      "#dc2626",
      "#7c3aed",
      "#0891b2",
      "#be185d",
      "#4b5563",
    ];
    ```

  Run:

  ```bash
  node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts
  ```

  Commit checkpoint:

  ```bash
  git add src/lib/shared-accounts/components/stacked-balance-chart-data.ts src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts
  git commit -m "Add stacked balance chart data helper"
  ```

- [ ] 3. Expose the existing account type filter from `AccountTable`.

  Edit `src/lib/shared-accounts/components/AccountTable.svelte`.

  Change:

  ```ts
  let filter: AccountKind | "all" = "all";
  ```

  To:

  ```ts
  export let filter: AccountKind | "all" = "all";
  ```

  Keep the existing reset behavior:

  ```ts
  $: if (!filters.some((item) => item.id === filter)) filter = "all";
  ```

  This allows the dashboard to drive the chart from the same type filter the table already uses.

  Run:

  ```bash
  npm run typecheck
  ```

  Commit checkpoint:

  ```bash
  git add src/lib/shared-accounts/components/AccountTable.svelte
  git commit -m "Expose account table filter"
  ```

- [ ] 4. Add the reusable stacked chart component.

  Create `src/lib/shared-accounts/components/StackedBalanceChart.svelte`.

  Core shape:

  ```svelte
  <script lang="ts">
    import { fade } from "svelte/transition";
    import { AreaChart, Tooltip } from "layerchart";
    import { formatMoney } from "$lib/shared-money/money.ts";
    import { buildSparklineYAxis, formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
    import type { StackedBalanceChartData } from "./stacked-balance-chart-data.ts";

    export let chart: StackedBalanceChartData = { dates: [], series: [], totals: [], signature: "" };
    export let currency = "TWD";
    export let label = "Balance";

    $: xDomain = chart.dates;
    $: yAxis = buildSparklineYAxis(chart.totals.map((point) => point.value));
    $: yDomain = [yAxis.min, yAxis.max];
    $: ariaLabel = `${label} ${currency}`;
  </script>
  ```

  Render with LayerChart:

  ```svelte
  {#if chart.series.length > 0}
    <div class="stacked-balance-chart" role="img" aria-label={ariaLabel}>
      {#key chart.signature}
        <div class="stacked-balance-stage" in:fade={{ duration: 150 }} out:fade={{ duration: 90 }}>
          <AreaChart
            data={chart.totals}
            flatData={chart.totals}
            x="date"
            y="value"
            series={chart.series}
            seriesLayout="stack"
            {xDomain}
            {yDomain}
            yBaseline={0}
            yNice
            axis={true}
            grid={{ y: true }}
            legend={{ placement: "bottom", variant: "swatches" }}
            motion={{ type: "tween", duration: 180 }}
            padding={{ top: 12, right: 14, bottom: 48, left: 56 }}
            height={260}
            props={{
              area: { class: "stacked-balance-area" },
              line: { class: "stacked-balance-line" },
              xAxis: { class: "sparkline-axis", format: shortDate },
              yAxis: {
                class: "sparkline-axis",
                format: shortAmount,
                ticks: yAxis.ticks,
                tickLabelProps: { "data-sensitive": "" },
              },
              grid: { class: "sparkline-grid" },
              tooltip: {
                item: {
                  props: { value: { "data-sensitive": "" } },
                },
              },
            }}
          >
            {#snippet tooltip({ context })}
              <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
                {#snippet children({ data })}
                  <div class="sparkline-tooltip-body stacked-balance-tooltip">
                    <span>{data?.dateLabel ?? data?.date ?? ""}</span>
                    {#each context.tooltip.series.filter((item) => item.visible) as item}
                      <div class="stacked-balance-tooltip-row">
                        <span>{item.label}</span>
                        <strong data-sensitive>{formatMoney({ currency, value: item.value ?? 0 })}</strong>
                      </div>
                    {/each}
                  </div>
                {/snippet}
              </Tooltip.Root>
            {/snippet}
          </AreaChart>
        </div>
      {/key}
    </div>
  {:else}
    <div class="stacked-balance-chart sparkline-empty" role="img" aria-label={ariaLabel}>
      No {currency} history
    </div>
  {/if}
  ```

  Add local styles that keep dimensions stable and constrain legend wrapping:

  ```css
  .stacked-balance-chart {
    min-height: 260px;
  }

  .stacked-balance-stage {
    height: 260px;
  }

  :global(.stacked-balance-area) {
    opacity: 0.36;
  }

  :global(.stacked-balance-line) {
    stroke-width: 2;
  }

  .stacked-balance-tooltip {
    min-width: 180px;
  }

  .stacked-balance-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  ```

  Reuse `shortDate`, `monthDay`, and `shortAmount` logic from `SnapshotSparkline.svelte`.

  Run:

  ```bash
  npm run typecheck
  ```

  Commit checkpoint:

  ```bash
  git add src/lib/shared-accounts/components/StackedBalanceChart.svelte
  git commit -m "Add stacked balance chart component"
  ```

- [ ] 5. Wire the Assets dashboard.

  Edit `src/lib/assets/AssetsDashboard.svelte`.

  Imports:

  ```ts
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import {
    buildStackedBalanceChartData,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  ```

  Remove the `SnapshotSparkline` import.

  Add state:

  ```ts
  let accountFilter: BalanceChartFilter = "all";
  ```

  Replace chart data derivation:

  ```ts
  $: chartRows = [...assets.dailyHistory].sort((left, right) => left.date.localeCompare(right.date)).slice(-30);
  $: chartData = buildStackedBalanceChartData({
    accounts: assetAccounts,
    dailyHistoryByAccount: assets.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "asset",
  });
  ```

  Keep `chartRows` only for currency-option derivation.

  Swap layout order so metrics come before the chart:

  ```svelte
  <section aria-label="Asset metrics">
    <SummaryStrip {metrics} />
  </section>

  <section class="card balance-history" aria-label="Asset balance history">
    ...
    <div class="pad balance-chart">
      <StackedBalanceChart chart={chartData} currency={chartCurrency} label="Asset allocation" />
    </div>
  </section>
  ```

  Bind the table filter:

  ```svelte
  <AccountTable
    accounts={assetAccounts}
    mode="asset"
    bind:search
    bind:filter={accountFilter}
    ...
  />
  ```

  Behavior to preserve:
  - `All Assets` chart stacks by account type.
  - `Bank` chart stacks by individual bank account.
  - Search text still filters the table only; it should not unexpectedly reshape the chart.

  Run:

  ```bash
  npm run typecheck
  ```

  Commit checkpoint:

  ```bash
  git add src/lib/assets/AssetsDashboard.svelte
  git commit -m "Show asset allocation as stacked balance chart"
  ```

- [ ] 6. Wire the Liabilities dashboard.

  Edit `src/lib/liabilities/LiabilitiesDashboard.svelte`.

  Add the same imports and state:

  ```ts
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import {
    buildStackedBalanceChartData,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";

  let accountFilter: BalanceChartFilter = "all";
  ```

  Build debt exposure chart data:

  ```ts
  $: chartData = buildStackedBalanceChartData({
    accounts: liabilityAccounts,
    dailyHistoryByAccount: liabilities.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "liability",
  });
  ```

  Swap metrics above the chart and replace `SnapshotSparkline`:

  ```svelte
  <StackedBalanceChart chart={chartData} currency={chartCurrency} label="Debt exposure" />
  ```

  Bind the table filter:

  ```svelte
  bind:filter={accountFilter}
  ```

  Behavior to preserve:
  - `All Debts` chart stacks by debt type.
  - `Credit Card` / `Loan` charts stack by individual account in that type.
  - Liability exposure displays as positive values.

  Run:

  ```bash
  npm run typecheck
  ```

  Commit checkpoint:

  ```bash
  git add src/lib/liabilities/LiabilitiesDashboard.svelte
  git commit -m "Show debt exposure as stacked balance chart"
  ```

- [ ] 7. Verify with local checks, production builds, and CDP.

  Run static checks:

  ```bash
  node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts
  npm run typecheck
  npm run build:renderer
  npm run build:electron
  git diff --check
  ```

  With the user-provided `npm run desktop:dev` already running, use the printed remote debugging port or default `9222`.

  First confirm CDP endpoint:

  ```bash
  curl http://127.0.0.1:9222/json/version
  ```

  CDP visual/DOM checks:
  - Navigate to Assets.
  - Confirm the metric strip appears before the balance chart in DOM order and visually.
  - Confirm `All Assets` renders multiple `path.lc-area-path` elements.
  - Click `Bank`; confirm the number of area paths changes to the number of visible bank account series and the chart fades/animates without layout jump.
  - Confirm y-axis values and tooltip values have `data-sensitive`.
  - Navigate to Liabilities and repeat for `All Debts`, `Credit Card`, and `Loan`.
  - Capture screenshots at desktop width and a narrow width; check legend wrapping does not overlap the plot or table.

  Suggested CDP assertions from page context:

  ```js
  ({
    areaPathCount: document.querySelectorAll("path.lc-area-path").length,
    metricsBeforeChart:
      document.querySelector('[aria-label="Asset metrics"]')?.compareDocumentPosition(
        document.querySelector('[aria-label="Asset balance history"]')
      ) === Node.DOCUMENT_POSITION_FOLLOWING,
    sensitiveTicks: document.querySelectorAll(".sparkline-axis [data-sensitive]").length,
  })
  ```

  Final commit checkpoint if any verification fixes were needed:

  ```bash
  git status --short
  git add src/lib/shared-accounts/components src/lib/assets/AssetsDashboard.svelte src/lib/liabilities/LiabilitiesDashboard.svelte
  git commit -m "Verify stacked balance charts"
  ```

## Risks And Decisions

- The chart follows the account type filter, not search text. This keeps search as a table affordance and avoids chart data changing while typing.
- Legend length is bounded by the user's chosen granularity: all view uses account types; type view uses accounts only within that type.
- Same-series updates use LayerChart `motion`; changes that replace the series set use a short keyed fade to avoid broken morphs between unrelated series.
- Values remain compatible with hidden-value mode by marking y-axis ticks and tooltip values with `data-sensitive`.
