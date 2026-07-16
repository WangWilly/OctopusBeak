# Spending Brush–Pan–Zoom Prototype Design

## Goal

Replace the three-concept comparison HTML with one focused prototype based on LayerChart's cartesian `brush` and domain transform behavior. The prototype must demonstrate a practical interaction model that addresses both chart density and initial rendering cost.

## Scope

- Modify only the standalone prototype and its smoke check.
- Keep production Spending components and ledger data unchanged.
- Simulate the intended LayerChart interaction in dependency-free HTML, CSS, and JavaScript; production integration will use LayerChart after the prototype is approved.
- Reuse representative monthly spending data and the current app's visual language.

## Progressive detail

The initial domain shows the complete history with one total bar per month. This keeps the overview readable and reduces the initial mark count.

When the visible domain contains 10 or fewer months, each month expands into the existing paired source presentation: e-invoice and account-spending bars, with category stacks inside each source. Panning or zooming back out beyond the threshold returns to monthly totals.

Only the visible detailed months are rendered. The full dataset remains available to the navigation model so panning stays constrained to real data boundaries.

## Interactions

- Drag at the full-history level to draw a brush and zoom to that range.
- Drag while zoomed to pan horizontally.
- Shift-drag at any scale draws a new brush selection.
- Horizontal trackpad movement pans while zoomed.
- Command/Ctrl plus wheel or pinch zooms around the pointer position without hijacking ordinary page scrolling.
- Double-click zooms in; Shift-double-click zooms out.
- Visible Zoom in, Zoom out, and Reset buttons provide discoverable and keyboard-accessible alternatives.
- Zoom is constrained to the full data domain and a maximum scale of 6×.

## Interface

The chart header shows the current visible date range and whether the chart is in Overview or Category detail mode. A concise instruction row changes with the mode.

The chart includes:

- a y-axis grid and compact month labels;
- a hover tooltip with total or source/category values;
- a translucent brush rectangle during selection;
- a selected-month outline that continues to open the daily detail behavior conceptually;
- the existing category legend in detail mode;
- a Reset control that is disabled at the full-history domain.

## Accessibility and fallback

- The chart has a descriptive accessible label and a hidden list summarizing visible data.
- Controls use native buttons and visible focus styles.
- Reduced-motion preference disables animated transitions.
- Keyboard users can use Zoom in, Zoom out, Reset, and left/right pan buttons; pointer gestures are optional enhancements.
- On narrow screens, controls wrap and the chart retains a minimum usable height.

## Verification

The Playwright smoke check will verify:

- the page contains one brush–pan–zoom prototype rather than three alternatives;
- the initial state is overview mode with the full domain;
- brushing or Zoom in changes the visible range and reaches detail mode;
- panning changes the domain without crossing dataset bounds;
- Reset restores the full domain and overview mode;
- no 6/12/24-month segmented control is present.
