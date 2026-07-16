# Spending Chart Performance Design

## Goal

Keep the approved grab-and-glide interaction while removing visible drag stutter on the Spending monthly chart.

## Evidence

- The live Electron page loads Spending data in about 143 ms with a 90 KiB payload.
- Dragging does not call `spending.load()`.
- Thirty months currently produce 420 bar marks and 685 SVG nodes.
- LayerChart `domain` transforms update the categorical scale on every pointer move, repositioning every SVG mark.

## Design

### Canvas marks

Use LayerChart's installed `layerchart/canvas` BarChart, Text, and Rect primitives for bars, axes, grid, and the selected-month outline. Keep the existing HTML tooltip and accessible hidden summaries. No new dependency is required.

### Virtual chart window

Keep all month bucket keys in the x-domain so panning remains continuous. Render only the visible month range plus two months of overscan on each side. The initial transform shows the latest 18 months; reset returns to that view. Zooming out may show more months, and the render window expands only as required by the viewport.

The existing untracked `spending-chart-window.ts` helper will be replaced with a viewport-based range helper. It will no longer expose 6/12/24 choices.

### Transform coalescing

Store the latest LayerChart transform event and publish scale/translation state at most once per `requestAnimationFrame`. Cancel a pending frame on component destruction. Date formatters are reused instead of constructed during every transform update.

## Data Flow

1. Full monthly rows determine the x-domain and y-domain.
2. Scale, translation, and stage width determine the visible month indices.
3. The render-window helper adds two months of overscan.
4. Only buckets inside that window are passed to the Canvas BarChart.
5. Drag feedback and edge fades use the coalesced viewport state.

## Accessibility and Interaction

- Hidden row summaries continue to expose every month to assistive technology.
- Canvas hit testing continues to support month selection and tooltips.
- Grab/grabbing cursors, edge fades, visible-range feedback, and reset remain.
- Reduced-motion behavior remains unchanged.

## Non-goals

- Do not add range buttons or restore the rejected chart selector.
- Do not paginate or cache the database load. The measured load is not the drag bottleneck.
- Do not add a custom chart engine or dependency.

## Verification

- Unit-check viewport/window boundaries and overscan.
- Browser-check Canvas rendering, direct drag, zoom, reset, tooltip selection, and no load during drag.
- In Electron, confirm fewer rendered marks and compare drag responsiveness.
- Run typecheck, production build, and the full test suite.
