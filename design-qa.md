# Spending Grouped + Stacked Chart Design QA

- Source visual truth: `/var/folders/z9/lk2s3y4x75n5fs1qpph6_ppw0000gn/T/codex-clipboard-e55e067f-c521-4b2d-9086-025568012806.png`
- Approved selection direction: B, full-period neutral background from `.superpowers/brainstorm/21987-1784257260/content/selection-style.html`
- Implementation screenshot: `/tmp/spending-group-stack-implementation.png`
- Side-by-side comparison: `/tmp/spending-group-stack-comparison.png`
- Viewport: Electron 1600 × 907 CSS pixels; source and implementation normalized to a common 900 px comparison height.
- State: Spending route, latest month selected, transform reset, grouped invoice/account bars visible.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: Existing app fonts, weights, numeric treatment, and hierarchy are unchanged. The selected x-axis label remains bold.
- Spacing and layout rhythm: The chart stays inside the existing Monthly spending card. Source groups are consistently spaced within each month, category segments form continuous stacks, and the month band fills one period slot without crossing adjacent months.
- Colors and visual tokens: Category colors and surface tokens are preserved. The selected month uses a subtle neutral `var(--fg)` mix behind the bars instead of a black outline.
- Image quality and asset fidelity: The target contains no raster assets or new icons. Existing app icons remain unchanged and no placeholder imagery was introduced.
- Copy and content: Existing Spending labels, source key, legend, hint text, tooltip copy, and daily details remain unchanged.
- Interaction and accessibility: Direct drag, Command-modified wheel zoom, reset, tooltip, and selected-period semantics were exercised. The hidden chart summary and keyboard month actions remain present.
- Responsiveness: The 1600 × 907 Electron viewport has no chart/card overflow or clipped persistent controls. The bounded render window remains 20 months and 40 source groups after reset.

## Comparison History

1. First implementation pass replaced the drifting outline with the approved full-period background and correctly grouped sources, but every stack segment had a radius, producing disconnected pill shapes. Classified P2 because it weakened category-stack readability.
2. Changed LayerChart `Bar` rounding to `rounded="edge"` with a smaller radius and added a browser regression assertion that interior stack segments have zero radius.
3. Post-fix evidence in `/tmp/spending-group-stack-comparison.png` shows continuous stacked bars, a stable selected-month background, and no selection outline.

## Verification Evidence

- Electron CDP route: `file:///Volumes/projects02/libretto-playground/build/index.html#/spending`
- Rendered state: 20 months, 40 source groups, 140 invoice category bars, 140 account category bars, one selected-period band, zero selection outlines.
- Primary interactions: direct drag moved the transform, Command + wheel changed scale, reset restored the initial viewport, and tooltip became visible over the selected invoice stack.
- Console and page errors: none observed during the final CDP interaction run.
- Focused region: the monthly chart was inspected separately at original screenshot resolution because stack joins and the selected-period background are too small to judge from a full-page view alone.

## Follow-up Polish

No remaining P3 item is required for this change.

final result: passed
