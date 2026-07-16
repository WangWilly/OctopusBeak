# Spending LayerChart Alternatives Design

## Goal

Create one in-project Svelte comparison page with three interactive monthly-spending chart alternatives implemented by LayerChart itself. The rendered browser output is HTML, but no chart interaction is simulated with standalone JavaScript.

## Shared implementation

- Reuse the existing `SpendingBarChart` data mapping, category colors, axes, tooltip, legend, accessibility summary, and month-selection behavior.
- Add one optional interaction mode to `SpendingBarChart`; its default remains unchanged for the production Spending dashboard.
- Add one isolated comparison route using representative `MonthlySpendingRow` data. Do not connect the study page to the ledger or desktop API.
- Use the already-installed `layerchart@^2.0.0`; add no dependencies.
- Preserve keyboard focus, descriptive labels, responsive layout, and reduced-motion behavior.

## Concept A: Brush selection

Use LayerChart's `brush` implementation on the categorical x-axis. Dragging across month bands selects a visible period without changing the data or rebuilding bars. The card emphasizes direct range selection and shows concise instructions beside the chart.

This is the clearest choice when the main task is selecting a period. It does not provide detailed navigation after the selection.

## Concept B: Domain pan and zoom

Use LayerChart's `transform={{ mode: 'domain', axis: 'x' }}` implementation. Dragging pans across months; pinch, modifier-wheel, or double-click zooms the x-domain. Ordinary page scrolling remains available by requiring the platform modifier key for wheel zoom.

This offers fluid exploration and readable bar widths, but the gestures need visible instructions.

## Concept C: Brush plus transform

Use LayerChart's `brush` and domain `transform` together. A brush selection zooms to the selected month range; the zoomed chart can then be panned. LayerChart transform controls expose Zoom in, Zoom out, and Reset actions as discoverable keyboard-accessible alternatives to gestures.

This is the recommended option because it combines precise range selection with continued exploration. It is also the most interaction-heavy concept.

## Comparison page

- Add a dedicated `/spending-chart-study` route containing the three concepts in one vertically scrollable page.
- Keep identical sample data, dimensions, chart styling, and explanatory structure across all three cards so the interaction model is the comparison variable.
- Label each card with its LayerChart configuration and a short advantage/trade-off note.
- Do not add the page to production navigation; it is an explicit study URL only.
- Remove the standalone simulated prototype after the LayerChart study route is verified, while retaining its smoke-check filename for the new route check if practical.

## Verification

- Component-level checks verify the optional interaction mode maps to brush, transform, or both without changing the default mode.
- A browser smoke check opens `/spending-chart-study`, confirms three LayerChart charts render, and exercises the primary interaction for each concept.
- `npm run typecheck` and the full project test suite must pass.
