# Automation Active Task Jump — Design Spec

## Goal

Replace the running-summary 「查看日誌」 action with a compact list of active tasks. Selecting a task reveals and scrolls to that task's inline log on the Automation page.

## Scope

- This specification now describes the production implementation.
- Reuse the current Automation visual system and page structure.
- Keep 「停止全部」 as the only summary-level action.
- Do not add a log modal, filters, progress aggregation, or new task-management behavior.

## Running Summary

- The heading continues to show the number of concurrently running tasks.
- Below the heading, render active, waiting-for-human, and failed tasks as circular icon buttons in a horizontally scrollable layer.
- Hover and keyboard focus reveal a tooltip with the task name, stage, state, and timestamp.
- The former 「查看日誌」 button is absent.

## Selection Interaction

When an active task is selected:

1. Open the workflow stage containing that task if it is collapsed.
2. Reveal that task's inline log if it is collapsed.
3. Close any previously expanded inline log so only the selected task remains open.
4. Smooth-scroll the selected task row into view with enough top offset for the fixed application header.
5. Apply a short blue focus highlight to the target log container, then remove it automatically.
6. Move keyboard focus to the inline log panel without triggering a second scroll.

Starting or polling a task must not automatically expand logs or move the viewport.

## Production State

- Show every active, waiting-for-human, and failed task in the summary.
- Tasks can appear across workflow stages; selecting one opens its collapsed stage.
- Labels, statuses, timestamps, and log output come from the current page model.

## Accessibility

- Active-task items use buttons, not generic clickable containers.
- Each button names both the task and the action, for example 「前往玉山信用卡對帳單日誌」.
- Each button's accessible name includes both the log action and task name.
- The target log panel receives programmatic focus.
- Smooth scrolling is disabled when `prefers-reduced-motion: reduce` is active; the focus highlight remains.
- Status is conveyed by text, not color alone.

## Verification

- The page initially shows no inline logs expanded.
- Selecting each summary task opens the correct stage and log.
- Opening another log closes the previously expanded log.
- Repeated selection of the same task still repositions and highlights it.
- Simulated task start does not expand or scroll.
- Escape has no special behavior because this design uses no modal.
- Verify desktop layout at 1600 × 1000 and a narrow responsive state.
