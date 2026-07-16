# Spending Chart Alternatives Design

## Goal

Create one standalone HTML comparison page with three interactive alternatives to the current 6/12/24-month range buttons. The prototype helps choose an interaction model before changing the Spending application.

## Shared visual direction

- Match the existing desktop app: neutral background, white cards, dark typography, compact controls, and the current spending-category colors.
- Use representative monthly spending data rather than connecting to the ledger.
- Keep all three concepts on one page with a sticky concept switcher so they can be compared quickly.
- Use native HTML, CSS, and JavaScript only. No dependencies and no changes to production components.
- Support keyboard focus, descriptive labels, reduced motion, and responsive layouts.

## Concept A: Overview and drilldown

Show the full date range as a low-density monthly total chart. Each month uses at most two marks: e-invoice and account spending. Selecting a month updates a category breakdown beside or below the overview.

This is the clearest and fastest concept because the overview does not render every category for every month. Its trade-off is that category trends across multiple months are not visible simultaneously.

## Concept B: Horizontal timeline

Keep the existing stacked-category bars, but place them on a horizontally scrollable timeline with a fixed readable bar width. The chart starts at the latest months, supports trackpad scrolling and drag-to-pan, and includes a compact visible-range indicator.

This preserves the current chart language and enables direct category comparison. Its trade-off is that the user cannot see the full history at once.

## Concept C: Focus and context

Show a compact full-history overview above a detailed stacked chart. A draggable selection window in the overview controls which months appear in the detail chart. The prototype provides visible handles and keyboard-adjustable range controls.

This offers the strongest balance between full-history context and detailed comparison. It is also the most complex interaction and will require more implementation and accessibility work than the other concepts.

## Prototype interactions

- A: click or keyboard-select a month to update its category breakdown.
- B: scroll, drag, or use previous/next controls to pan the timeline.
- C: drag the overview selection window or its handles to change the detailed range.
- Each concept includes a concise recommendation note and trade-off summary.

## Deliverable and acceptance

- Deliver one standalone HTML file under `docs/prototypes/`.
- The file opens directly without a build step or server.
- All three concepts are visibly distinct and interactive.
- No 6/12/24-month segmented control appears in any concept.
- Production Spending code and ledger data remain unchanged until the user chooses a concept.
