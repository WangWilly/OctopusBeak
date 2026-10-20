# The Active Automation Task Run owns its run's lifecycle

Status: accepted

## Decision

Before this decision, an Automation Task Run's state was spread across eight taskId-keyed maps and sets in the runner and executor. Its terminal status was written from four places. Cancellation was detected by polling flags every 50 ms and by matching the error message "Automation task cancelled.". The runtime snapshot was rebuilt from a re-read database row after each change, which dropped in-memory cancellation state. This produced runs stuck in `preparing` or `cancelling` until the next restart, `cancelling` regressing to `running`, and a force-quit control that disappeared after any progress update.

So each Active Automation Task Run has exactly one owner in the App process, created when its task is claimed, with its run row created at the same moment.

- **Single writer.** Only the owner changes the run's status. The runner, the executor, the CAPTCHA Retry Campaign ([ADR 0015](0015-bounded-captcha-retry-campaigns.md)) and human assistance request transitions through it and never write status directly. Startup recovery of rows left by a previous process is the only exception and records them `interrupted`.
- **Monotonic transitions.** One transition table, shared by the owner and the operational store's conditional updates, rejects illegal moves. A `cancelling` run can only become terminal. Plain run updates cannot change status.
- **Snapshot as projection.** The owner publishes the runtime snapshot from its last persisted row plus its live cancellation state, in the same step as each write. Nothing else rebuilds the snapshot from the database.
- **Pushed cancellation.** The owner holds an abort signal. Cancellation, force-quit and shutdown abort it with distinct reasons. Executions, campaign cooldowns, queue waits and human-assistance waits listen to it instead of polling.
- **Typed terminal outcome.** Callers report what happened. The owner resolves the terminal outcome with this precedence: commit outcome unknown, then force-quit, then requested cancellation, then shutdown (`interrupted`), then the reported result. Finalization is idempotent. `exitCode` and `signal` are no longer produced; their operational columns stay until a later schema change removes them.
- **Force-quit is immediate.** An Automation Task Run Force-quit terminates the workflow worker without the cleanup grace an ordinary cancellation allows. The force-quit control still becomes available only after a cancellation has had time to finish cleanly.

## Considered options

- **Keep polling and centralise the flags.** Rejected. It keeps a second notion of "cancelled" that executions and campaign cooldowns must remember to check, and shutdown still cannot stop a campaign between rounds.
- **Keep rebuilding the snapshot from the row and merge the live flags in.** Rejected. It fixes the lost force-quit control but keeps several snapshot writers, so the next live field is lost the same way.
- **Let human assistance keep its own status writes.** Rejected. Its read-then-write gap lets a cancellation be overwritten by `waiting_for_human`; the transition table is only sound with one writer.
- **Keep force-quit as a cancellation that waits for completion.** Rejected. It made force-quit indistinguishable from cancel, contrary to its definition.

## Consequences

- The runner becomes an instance created by the Electron main process, so its module-level state no longer leaks between checks.
- Scheduled collection receives a finished notification for every terminal run, including queue cancellation, failures thrown by the runner and shutdown; it decides which outcomes notify the person.
- [ADR 0032](0032-app-owned-workflow-runtime.md) slot retention and ADR 0015's one persisted run per campaign are unchanged: the owner lives for the whole campaign.
