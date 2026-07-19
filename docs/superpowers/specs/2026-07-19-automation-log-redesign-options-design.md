# Automation Log Redesign Options

## Goal

Create three interactive HTML prototypes for the shared modal that displays every currently running task's live log, then let the user choose one before production implementation. Independently remove the aggregate progress bar from the production Automation hero.

## Shared constraints

- Keep the existing Automation visual system, Traditional Chinese copy, modal backdrop, task data, semantic states, and desktop density.
- The modal shows all currently running tasks at the same time; it is not a one-task switcher.
- Opening the modal must not change task execution. Starting a task must not open the modal or an inline log.
- Each prototype uses realistic raw log text, long paths, success/running/error states, and at least four concurrent tasks.
- The close action, Escape key, scrolling, and visible task-state updates must work.
- Prototype work remains isolated from the production app until an option is selected.

## Direction 1: Task stack

- One full-width task section per running task in a single modal scroll area.
- Sticky task header contains name, state, elapsed time, and collapse control.
- Every task is expanded initially; users may collapse noisy tasks while leaving several logs visible.
- Best for readability, raw-log fidelity, and the smallest production implementation.

## Direction 2: Console matrix

- Responsive two-column grid of equal task consoles, collapsing to one column at narrow widths.
- Each console has an independent vertical scroll, follow-tail toggle, and compact state header.
- The modal itself keeps a stable header and footer while consoles use the available height.
- Best for operators comparing several tasks side by side.

## Direction 3: Merged event stream

- One chronological stream combines entries from every running task.
- Each entry includes timestamp, task label, level, and message; task chips filter the shared stream without hiding the fact that multiple tasks are running.
- Search, pause-follow, and error-only controls are interactive in the prototype.
- Best for quickly locating failures, but production implementation would require reliable per-line timestamps or ingestion metadata.

## Production hero change

- Remove the aggregate progress bar and percentage from the active Automation hero.
- Keep the running-task count on the left, show the active-task icon strip beneath it for inline-log jumps, and keep `停止全部` on the right.
- Preserve per-task status/progress in the task table; only the hero aggregate is removed.

## Prototype delivery

- Deliver one local prototype with three directly addressable variants and an in-prototype option switcher.
- Use mock-only state; do not call Electron automation APIs or launch banking workflows.
- Verify all primary controls, responsive layout, and console output before handoff.

## Verification

- Add a focused production source check proving the hero no longer renders the aggregate progress block.
- Run the focused check, typecheck, production build, and `git diff --check`.
- Capture each prototype at the same desktop viewport and record a design-QA comparison against the supplied modal screenshots.
