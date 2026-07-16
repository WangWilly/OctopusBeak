# Spending Grab-and-Glide Chart Design

## Goal

Replace the fixed month-range controls and temporary chart-concept selector on the Spending page with one direct-manipulation monthly chart. Users browse history by dragging the chart itself and zoom only when they intentionally hold the platform modifier key while scrolling.

## Selected Direction

The approved direction is **A — Grab and Glide**.

- The monthly chart is the interaction surface; no 6/12/24-month buttons remain.
- No overview brush, timeline rail, central selection lens, or permanent zoom toolbar is added.
- The existing stacked category bars, source pairing, tooltip, legend filtering, selected-month highlight, and click-to-select behavior remain.
- The chart stays visually quiet at rest. Interaction guidance appears only where it helps users discover or understand dragging.

## Interaction

### Pan and zoom

Configure the existing LayerChart monthly chart with domain transform on the horizontal axis:

```ts
{
  mode: "domain",
  axis: "x",
  scrollMode: "scale",
  scrollActivationKey: "meta",
  scaleExtent: [1, 6],
}
```

- Pointer drag pans horizontally and is constrained to the available monthly data.
- Command on macOS or Control on Windows/Linux plus wheel zooms horizontally. Ordinary wheel events continue scrolling the page.
- Trackpad pinch remains available through LayerChart's native transform behavior.
- Keep LayerChart's native double-click zoom behavior; do not add separate zoom buttons.
- The initial view uses the current chart domain and selected month. The implementation must not reintroduce a fixed 6/12/24-month window.

### Click versus drag

- Clicking a bar still selects that month and runs the existing Spending month-loading flow.
- Pointer movement above LayerChart's click-distance threshold is a drag and must not trigger month selection.
- Category legend interactions remain clickable and must not start a pan gesture.

### Feedback

- The chart uses a grab cursor when it can pan and a grabbing cursor while dragging.
- While the transform is moving, a compact floating label shows the first and last visible months.
- Subtle left and right edge fades indicate that additional history exists beyond the visible domain. A fade disappears when its corresponding data boundary is reached.
- A short localized hint explains drag and modifier-key zoom. It must not be presented as a boxed control.
- Keep the existing reset control inside `SpendingBarChart` available only when zoomed; do not add an always-visible toolbar.

## Component Changes

### `SpendingDashboard.svelte`

- Remove the temporary `SpendingChartAlternatives` integration.
- Render the existing `SpendingBarChart` with every `model.monthlyRows` row, `kind="month"`, the current selected key, the existing month-selection callback, and pan/zoom interaction.
- Keep the lower month toolbar and daily-detail entry point unchanged; they remain alternate precise navigation paths.

### `SpendingBarChart.svelte`

- Reuse its existing LayerChart context and pan/zoom interaction support.
- Add only the moving visible-range label, boundary-aware fades, cursor states, and localized hint required by the selected design.
- Derive visible-range feedback from the LayerChart context instead of duplicating chart-window state.

### Temporary alternatives

- Remove `SpendingChartAlternatives.svelte` after its only caller is replaced.
- Keep shared interaction helpers only if they are still used by `SpendingBarChart`; delete dead concept-specific code.
- Do not add a new component abstraction for the feedback elements unless the existing chart file becomes harder to read without one.

### Localization

- Add English and Traditional Chinese strings for the drag/zoom hint and visible-range label.
- Remove temporary prototype labels that are no longer rendered.

## Data Flow

1. `SpendingDashboard` passes the complete monthly row collection and selected month to `SpendingBarChart`.
2. LayerChart owns the horizontal domain transform and constrains pan/zoom to the data.
3. `SpendingBarChart` reads the current visible x-domain for transient feedback only.
4. A bar click calls the existing `selectMonth` flow, which reloads Spending data and updates the selected month.
5. Panning or zooming changes only chart presentation; it does not reload or filter Spending data.

## Edge and Failure States

- With too few months to pan, edge fades and drag affordance remain hidden; bar selection still works.
- At scale `1`, zoom reset UI is hidden and the full available domain remains reachable.
- At either data boundary, further pan is clamped and the matching edge fade is hidden.
- If transform context is unavailable during initial render, the chart renders normally without feedback rather than blocking the Spending page.
- Loading or month-selection failures keep the existing Spending rollback behavior; chart navigation introduces no new persistence or network error state.

## Accessibility

- Retain the chart's current accessible label and bar-selection semantics.
- The hint is readable text and does not rely on an icon alone.
- Focus outlines remain visible for legend and reset controls.
- Do not animate the floating label or fades when `prefers-reduced-motion: reduce` is active.
- Direct dragging is an enhancement: the existing lower month buttons remain the keyboard-operable method for choosing a precise month.

## Verification

- Extend the smallest existing interaction check to confirm the approved domain-transform configuration.
- Add translation assertions for every new English and Traditional Chinese string.
- In the live Spending route, verify:
  - dragging pans without selecting a month;
  - clicking a bar still selects its month;
  - ordinary wheel scrolling does not zoom the chart;
  - Command/Control plus wheel zooms within the configured extent;
  - edge fades match the visible-domain boundaries;
  - the visible-range label appears only while moving;
  - the lower month toolbar still selects a precise month;
  - no renderer console error occurs.
- Run the focused checks, `npm run typecheck`, `npm run build`, and `git diff --check`.

## Non-goals

- No new charting, gesture, state-management, or animation dependency.
- No overview brush, miniature chart, time rail, date-range form, or fixed range presets.
- No changes to Spending aggregation, persistence, invoices, daily-detail views, or the lower month toolbar.
- No unrelated visual redesign of the Spending page.
