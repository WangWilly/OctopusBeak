# Automation Session Lifecycle Design

## Goal

Prevent Libretto daemon, Chromium, and esbuild processes from surviving automation tasks indefinitely while preserving the existing human-assisted workflow.

Only a task explicitly in `waiting_for_human` may keep its browser session open. The wait is limited to 20 minutes. Completed, failed, cancelled, timed-out, force-quit, and App-terminated tasks must close their sessions.

## Existing Behavior

Libretto launches its browser daemon as a detached process. A workflow failure or pause intentionally leaves that daemon and browser open for inspection or resume.

The automation runner tracks the direct Libretto CLI child, but not the complete detached process lifecycle. It closes a resumed session after a resume failure, while ordinary failed and paused runs can remain open. Cancelling a task sends `SIGTERM` only to the direct CLI child.

This ownership gap allows sessions to accumulate across daily automation runs. If Libretto session state later disappears, `libretto status` and `libretto close` can no longer identify the surviving daemon.

## Session Ownership

The automation runner owns every Libretto session started for an App task. It generates the session ID before spawning Libretto, passes that ID through `--session`, writes it to the existing task log, and associates the session ID and daemon PID with the current task run in memory. Retaining the PID lets the runner verify shutdown even if Libretto clears its state file during a nominal close. The existing task log remains the persisted source used to recover a session ID after an abnormal App exit; no new database field is required.

All terminal paths use one idempotent session-finalization operation:

- completed
- failed
- cancelled
- waiting timeout
- Assist force quit
- App shutdown or restart
- startup recovery after an abnormal exit

Concurrent requests to finalize the same session share one closing promise so that timeout, resume completion, force quit, and App shutdown cannot race or update the task run twice.

No database table or column is added. No Libretto dependency patch or independent watchdog service is introduced.

## Task Lifecycle

### Completed, Failed, or Cancelled

After determining the task result, the runner finalizes its Libretto session. A workflow failure retains its original error message. A cleanup failure is appended as secondary context and does not replace the workflow error.

### Waiting for Human

When a workflow explicitly pauses, the runner records the existing `waiting_for_human` status and starts an in-memory 20-minute timer at the moment that status is entered.

If the user resumes before the deadline, the timer is cancelled. The resumed workflow ends as completed or failed and then finalizes the session.

If the timer expires, the runner finalizes the session and updates the task run to `failed` with the error `等待人工操作超過 20 分鐘`.

### App Shutdown or Restart

For a normal window close, quit, or restart, Electron begins bounded shutdown cleanup before allowing the App process to exit. It cancels waiting timers, finalizes all App-owned sessions in parallel, and marks waiting task runs as `failed` with the error `App 關閉，人工操作未完成`.

The shutdown path must have a deadline so a broken browser cannot prevent the App from quitting forever. The per-session close escalation described below runs within that deadline.

### Abnormal App Exit

macOS Force Quit, `SIGKILL`, power loss, and crashes cannot run an App shutdown hook. On the next launch, the App inspects existing task runs in `running` or `waiting_for_human`, extracts their session IDs from the existing task log, reads the surviving Libretto session state, finalizes those sessions, and marks the runs as `failed` with the error `App 前次異常結束`.

Sessions from an abnormal exit are closed immediately at startup. Their previous 20-minute timers are not restored.

## Session Finalization

Finalization is scoped to one exact session:

1. Use the daemon PID retained by the runner, or read it from Libretto session state before requesting closure.
2. Run `libretto close --session <session>`.
3. Verify that the retained PID has exited.
4. If it remains alive, send `SIGTERM` to that daemon's process group.
5. Wait for a short bounded grace period.
6. If the same PID remains alive, send `SIGKILL` to that process group.
7. Cancel the session's waiting timer and remove its in-memory ownership record.

The PID must still identify the expected Libretto daemon before escalation. Cleanup must never use a broad command such as `pkill libretto`, because developer-owned sessions may be running at the same time.

The existing Assist force-quit action uses this same finalization path instead of maintaining separate process cleanup behavior.

## Status and Error Rules

- `waiting_for_human` is the only non-terminal status allowed to retain a browser.
- A 20-minute wait becomes `failed` with a timeout error.
- Normal App shutdown turns an unfinished waiting run into `failed` with an App-shutdown error.
- Startup recovery turns a run left active by an abnormal exit into `failed` with an abnormal-exit error.
- A completed task remains completed if redundant cleanup reports that the session is already closed.
- A failed task retains its workflow error; cleanup failure is appended.
- Cleanup failures are logged with the session ID and retained PID for diagnosis.

## Scope

Reuse the existing automation runner, human-session helpers, task-run store, Libretto session-state reader, and Electron lifecycle wiring.

Do not add:

- a new database schema or timeout record
- a cron job, launchd job, or standalone watchdog
- a global process scan or broad process kill
- a patch to installed Libretto files
- automatic retention of ordinary failed workflows for debugging

Developers can still preserve a browser when running Libretto directly outside the App. This design changes only sessions owned by App automation tasks.

## Testing

Add focused automated checks for:

1. Completed, failed, and cancelled task paths finalize their sessions.
2. `waiting_for_human` retains its session before 20 minutes.
3. The 20-minute deadline finalizes the session and records the timeout failure.
4. Resume and timeout racing against each other finalize once.
5. Assist force quit uses the shared finalization path.
6. Normal App shutdown finalizes all waiting sessions and records App-shutdown failures.
7. Startup recovery finalizes sessions from stale running or waiting task runs and records abnormal-exit failures.
8. A graceful close that leaves the recorded daemon alive escalates only that daemon's process group from `SIGTERM` to `SIGKILL`.
9. Repeated finalization is harmless when the session is already closed.

Run a desktop smoke test with a paused workflow and verify that timeout, force quit, and App quit leave no matching Libretto daemon, Chromium child, or esbuild service. A separate developer-started Libretto session must remain untouched.

## Success Criteria

- Only an active `waiting_for_human` task may retain an App-owned browser session.
- Waiting sessions are forcibly closed after 20 minutes and recorded as failed.
- Normal App close and restart close all App-owned sessions before exit.
- Abnormal App exits are reconciled on the next launch.
- Cancellation closes the detached daemon and its process tree, not only the direct CLI child.
- Cleanup targets exact sessions and does not affect unrelated developer workflows.
- Repeated daily automation runs no longer accumulate Libretto daemon, Chromium, or esbuild processes.
