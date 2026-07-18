# Automation Logging Variants

## Goal

Make parallel sync easier to start, then compare three logging presentations without changing the underlying task flow.

## Shared launch flow

- Hero shows only `14 個任務可以同步執行` and one `同步全部` action.
- Remove the summary counts and `調整任務` action.
- The confirmation sheet keeps only its title, credential readiness, selected task list, `取消`, and `開始同步`.
- Remove the running-task check, dependency check, downstream-unlock check, multi-window warning, and acknowledgement checkbox.

## Logging variants

All variants use the same live run state and realistic timestamped events. The selected mode is controlled by the `logging` query parameter so each version has a direct link.

1. `drawer`: after launch, the right sheet becomes `即時日誌`, with aggregate progress, latest events, error emphasis, and stop-all.
2. `inline`: each running task row exposes a `日誌` control; the selected task expands beneath its row with recent events.
3. `console`: a bottom panel shows a dense chronological stream across all tasks, with a collapse control.

## Behavior and error handling

- Starting sync launches every selected task with one click.
- Logs advance from the same timer as progress, so all three presentations stay consistent.
- A simulated failure event is visually distinct and identifies the task; no backend, persistence, scheduling, or retry system is added.
- Existing credential and run-history dialogs remain available.

## Verification

- Unit-test log event generation and existing parallel-run state.
- Verify launch and log visibility for all three query-parameter variants.
- Check responsive behavior, browser console, production build, and update the existing Sites deployment.
