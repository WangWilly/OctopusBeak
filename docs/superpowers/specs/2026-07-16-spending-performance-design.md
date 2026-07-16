# Spending Performance And Date Normalization Design

## Goal

Make the Spending page load and resize smoothly, keep its monthly chart readable, and prevent padded Taiwan ROC years such as `0113` from appearing as Gregorian year 113.

## Confirmed Causes

- The monthly chart currently renders every month, two sources, and seven categories. With current data this produces 420 SVG bar segments and about two seconds of initial chart work.
- Collapsing or expanding the sidebar resizes the chart. LayerChart then recomputes the full SVG, producing main-thread tasks around 250–290 ms.
- HNCB account rows contain four-digit, zero-padded ROC dates such as `0113-08-19`. `normalizeDateValue` checks four-digit Gregorian dates before ROC dates, so these values remain year `0113`.
- SQLite and Spending model loading are not the bottleneck; observed IPC loads are approximately 48–104 ms.

## Design

### Date normalization

Treat a four-digit date whose year begins with `0` as a zero-padded ROC year. Convert it by adding 1911 before returning the normalized `YYYY-MM-DD` value. Preserve existing handling for normal four-digit Gregorian years and two- or three-digit ROC years.

Existing incorrect HNCB rows are repaired through the existing import path: after the parser change, re-importing the source files updates their normalized date fields. No broad database rewrite or heuristic correction of unrelated banks is added.

### Monthly chart window

The chart renders a bounded, selected-month-aware slice of the existing `monthlyRows`:

- Default range: 12 months.
- Available ranges: 6, 12, and 24 months.
- The selected month remains visible. The range ends at the selected month when possible; near the beginning of the dataset it uses the first complete range.
- The existing month strip remains the navigation mechanism for older periods. Selecting a month moves the chart window to include it.
- Summaries, filters, daily records, and totals continue to use the complete Spending model; only monthly chart rendering is windowed.

Use native buttons and existing styles. Do not add a chart, gesture, zoom, or state-management dependency.

### Sidebar resizing

No sidebar-specific workaround is added initially. Reducing the monthly chart from 420 segments to at most 336 segments at the 24-month setting, and normally 168 segments at 12 months, addresses the expensive responsive redraw at its source.

If live verification still shows resize tasks above 100 ms at the default 12-month range, the fallback is to defer one chart resize until the sidebar transition ends. This fallback is not implemented unless measurement requires it.

## Testing

- Add a parser check proving `0113/08/19` becomes `2024-08-19` while `2025/08/19` stays unchanged.
- Add a pure chart-window check for 6, 12, and 24 months, including selections at the beginning, middle, and end.
- Run the focused parser and chart-window checks, typecheck, and production build.
- Verify the live Electron Spending page through CDP:
  - default chart has no more than 12 months and 168 bar segments;
  - selecting an older month keeps that month visible;
  - sidebar collapse and expansion remain functional;
  - no renderer console error appears;
  - measure sidebar resize long tasks and only add the fallback if the default range remains above 100 ms.

## Non-goals

- Database caching or new indexes.
- Virtualizing invoice rows.
- A continuous pinch or wheel zoom interaction.
- A new charting dependency.
- Automatic mutation of unrelated source data.
