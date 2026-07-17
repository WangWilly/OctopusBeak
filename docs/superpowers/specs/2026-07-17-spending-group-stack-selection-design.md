# Spending Grouped + Stacked Chart Design

## Goal

Use LayerChart's grouped-and-stacked data model for monthly spending and replace the transform-sensitive selection outline with a stable month background.

## Chart structure

- `periodKey` (month or day) is the primary x-axis value.
- `source` (`invoice` or `account`) is the group within each period.
- Spending category is the stack within each source bar.
- `groupStackData` produces the bar records consumed by `Chart`, `Layer`, and `Bar`.
- Colors, category filtering, tooltips, click behavior, and source order stay unchanged.

## Selection

The selected period uses option B from the approved visual comparison:

- A subtle neutral band fills the selected period's full x-axis slot behind both source bars.
- The selected tick label remains bold.
- The current outline around the two bars is removed.
- The band is derived from the period scale, so it follows pan and zoom as one unit and does not depend on bar heights or the distance between source bars.

## Performance and interaction

- Keep the existing visible-window rendering and overscan.
- Keep the full period domain so pan and zoom retain their current range.
- Keep requestAnimationFrame-coalesced transform updates.
- Render only the visible grouped-and-stacked bar records.
- The selected band is rendered only when the selected period is in the current render window.

## Accessibility

- Preserve the existing hidden summary and keyboard actions.
- Preserve selected-period information in the chart accessible label.
- Selection is communicated by both the background band and bold tick text, not color alone.

## Verification

- A focused data check proves each period has two source groups and each source contains category stacks.
- The browser check proves the old outline is absent, the selected month band is present, direct drag still moves the viewport, clicking a bar selects its period, and the render window remains bounded.
- Run the full test suite, typecheck, production build, and visual comparison at the same Spending-page viewport.
