# UI Library Evaluation Design

Date: 2026-07-02

## Context

The app is a Svelte 5 + SvelteKit/Electron personal portfolio dashboard. The current UI is mostly hand-rolled:

- `DashboardShell.svelte` owns the sidebar, topbar, value visibility state, and route-level chrome.
- `AccountTable.svelte` and `DailyHistoryTable.svelte` each implement their own sorting, sort indicators, filtering, pagination, and row rendering.
- `SnapshotSparkline.svelte` implements custom SVG charting, including axis ticks, line/area paths, tooltip placement, and pointer interaction.
- `app.css` already has product-specific tokens, density, cards, table styles, modal styles, and responsive shell rules.

The requested evaluation is whether shadcn-svelte, TanStack Table, and LayerChart should be used to optimize the current UI.

## Findings

LayerChart has the clearest immediate fit. The app has repeated trend charts and custom SVG chart logic that can be replaced while preserving the current data API.

TanStack Table should not be adopted through `@tanstack/svelte-table` right now. The project uses Svelte 5, while TanStack's official installation docs still call out that the Svelte adapter targets Svelte 3/4 and recommends `@tanstack/table-core` plus a custom or community adapter for Svelte 5.

shadcn-svelte should not be adopted as a full visual rewrite. It is useful as a source-owned component system for primitive controls, but its SvelteKit guide assumes Tailwind setup and CLI-generated component folders. The existing UI already has a strong product shell, so replacing everything would add churn before solving a concrete pain point.

## Decision

Use a three-phase, smallest-useful rollout:

1. Adopt LayerChart for trend charts first.
2. Keep tables hand-rolled for now, but extract repeated sorting and pagination helpers if table behavior keeps spreading.
3. Add selected shadcn-svelte primitives only when replacing existing modal/button/input/switch/table markup pays for itself.

## Non-Goals

- Do not redesign the app shell.
- Do not replace `DashboardShell.svelte`.
- Do not add Tailwind only to satisfy shadcn-svelte.
- Do not adopt `@tanstack/svelte-table` unless it has a Svelte 5-safe path in this codebase.
- Do not move business data shaping into UI component libraries.

## Approach Options

### Option A: Full shadcn-svelte UI Migration

This would initialize shadcn-svelte, add primitives for the shell, dialog, buttons, inputs, tables, pagination, switch, and chart container, then rework the app CSS around the generated component style.

Tradeoff: It gives a consistent component vocabulary, but it is the most disruptive option and likely requires Tailwind or a parallel styling layer. It also risks flattening the product-specific density and shell that already work.

Verdict: Do not do this now.

### Option B: Table-First TanStack Migration

This would replace `AccountTable.svelte`, `DailyHistoryTable.svelte`, and the automation task table with TanStack Table state and row models.

Tradeoff: It becomes valuable if the app needs column visibility, row selection, faceted filters, multi-sort, or virtualized large tables. For current behavior, it introduces adapter work because Svelte 5 is not the happy path for `@tanstack/svelte-table`.

Verdict: Defer. Use `@tanstack/table-core` later only if table requirements grow.

### Option C: Chart-First LayerChart Migration

This would replace `SnapshotSparkline.svelte` internals with LayerChart while keeping its props stable:

- `rows`
- `currency`
- `amountKey`
- `label`

Overview, assets, and liabilities pages would continue to call the same component. The chart would use existing CSS tokens for colors and typography.

Tradeoff: Adds one dependency, but removes the highest-maintenance custom visualization code.

Verdict: Recommended first step.

## Proposed Design

### Phase 1: LayerChart Adapter

Create a chart adapter inside `SnapshotSparkline.svelte` or a nearby helper only if needed. It should map `DailyHistoryRowDto[]` to simple `{ date, value }` points and render the existing trend chart using LayerChart primitives.

Keep the public component API unchanged so these existing callers do not change:

- `OverviewDashboard.svelte`
- `AssetsDashboard.svelte`
- `LiabilitiesDashboard.svelte`

The visual output should preserve:

- current chart labels
- current currency selector behavior
- empty-state text
- value privacy behavior through `[data-sensitive]`
- responsive width

LayerChart should own scale, axes, line/area drawing, and tooltip mechanics. The app should still own money formatting and currency filtering.

### Phase 2: Table Cleanup Without TanStack

Before adopting TanStack, remove local duplication where it is cheap:

- one tiny sort helper for date/string/number comparisons
- one tiny pagination helper for page bounds and row slicing
- keep all row markup inside each table component

This keeps the diff small and avoids a Svelte 5 adapter decision until a table feature actually needs TanStack.

TanStack Table becomes justified when at least one of these is requested:

- multi-column sorting
- column visibility controls
- row selection across pages
- faceted filtering
- virtualized large tables
- shared column definitions across multiple tables

If adopted later, prefer `@tanstack/table-core` with a thin local Svelte 5 adapter rather than `@tanstack/svelte-table`.

### Phase 3: Selective shadcn-svelte Primitives

Only add shadcn-svelte primitives when they replace repeated or fragile UI code:

- `Dialog` for account, asset, transaction, credential, log, and viewer modals
- `Button` for primary/secondary/action controls
- `Input` for search and credential inputs
- `Switch` for value visibility
- `Table` and `Pagination` only if they reduce markup without forcing a TanStack migration

Do not add shadcn-svelte `Sidebar`; the existing sidebar is app-specific and already handles collapsed state, route navigation, responsive behavior, branding, and portfolio side status.

## Data Flow

Data continues to flow through the existing page DTOs:

1. Svelte route loads dashboard data through `window.octopusBeak`.
2. Page dashboards derive view-specific arrays and currencies.
3. UI components receive DTO slices as props.
4. Chart/table components render only presentation state.

No library should fetch data, own persistence, or change DTO shapes.

## Error Handling

Library-backed components should preserve current empty and missing-data behavior:

- missing currency amount renders `--` in tables
- no chart points renders `No <currency> history`
- loading and route errors stay in `+page.svelte`
- chart rendering errors should not affect data loading behavior

## Testing

Minimum verification for Phase 1:

- `npm run typecheck`
- one browser visual check for overview, assets, and liabilities chart rendering
- confirm value privacy blur still hides chart tick values marked sensitive

Minimum verification for Phase 2:

- a small assert-based check or existing component-level check for sort/pagination helpers
- `npm run typecheck`

Minimum verification for Phase 3:

- `npm run typecheck`
- browser checks for modal open/close, focus behavior, Escape handling, and mobile layout

## Rollout

Start with Phase 1 only. If the LayerChart migration creates more code than it removes, stop and keep the existing SVG implementation.

Proceed to Phase 2 only if table duplication grows or table behavior changes.

Proceed to Phase 3 only when touching modal/control code for another concrete UI task.

## References

- shadcn-svelte docs: https://www.shadcn-svelte.com/docs
- shadcn-svelte SvelteKit installation: https://www.shadcn-svelte.com/docs/installation/sveltekit
- shadcn-svelte Data Table: https://www.shadcn-svelte.com/docs/components/data-table
- shadcn-svelte Chart: https://www.shadcn-svelte.com/docs/components/chart
- TanStack Table installation: https://tanstack.com/table/latest/docs/installation
- LayerChart GitHub: https://github.com/techniq/layerchart
