# Automation Active Task Jump — Design Spec

## Goal

Replace the running-summary 「查看日誌」 action with a compact list of active tasks. Selecting a task reveals and scrolls to that task's inline log on the Automation page.

## Scope

- Prototype first; do not change the production app in this pass.
- Reuse the current Automation visual system and page structure.
- Keep 「停止全部」 as the only summary-level action.
- Do not add a log modal, filters, progress aggregation, or new task-management behavior.

## Running Summary

- The heading continues to show the number of concurrently running tasks.
- Below the heading, render every active task as a compact clickable row or pill containing:
  - task name;
  - current state such as 「執行中」 or 「等待操作」.
- Items wrap when space is insufficient and remain readable with long task names.
- The former 「查看日誌」 button is absent.

## Selection Interaction

When an active task is selected:

1. Open the workflow stage containing that task if it is collapsed.
2. Reveal that task's inline log if it is collapsed.
3. Preserve any other manually opened inline logs.
4. Smooth-scroll the selected inline log heading into view with enough top offset for the fixed application header.
5. Apply a short blue focus highlight to the target log container, then remove it automatically.
6. Move keyboard focus to the inline log heading without triggering a second scroll.

Starting or polling a task must not automatically expand logs or move the viewport.

## Prototype State

- Show three concurrently active tasks in the summary.
- Place them across at least two workflow stages so the prototype proves collapsed-stage opening.
- Include realistic Traditional Chinese task names, statuses, timestamps, and log output.
- Provide a reset control only if needed to repeat the interaction; it remains secondary.

## Accessibility

- Active-task items use buttons, not generic clickable containers.
- Each button names both the task and the action, for example 「前往玉山信用卡對帳單日誌」.
- The target log heading receives programmatic focus.
- Smooth scrolling is disabled when `prefers-reduced-motion: reduce` is active; the focus highlight remains.
- Status is conveyed by text, not color alone.

## Verification

- The prototype initially shows no inline logs expanded.
- Selecting each summary task opens the correct stage and log.
- Other open logs remain open.
- Repeated selection of the same task still repositions and highlights it.
- Simulated task start does not expand or scroll.
- Escape has no special behavior because this design uses no modal.
- Verify desktop layout at 1600 × 1000 and a narrow responsive state.
