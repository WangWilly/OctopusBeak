# A fatal report explains, then quits in order

Status: accepted

Amends [ADR 0150](./0150-an-unusable-ledger-asks-to-retry-or-rebuild.md).

ADR 0150 stopped one failure, a ledger that refuses to open, from ending the App without a word. Every other fatal automation-runtime report still did. The main process logged one line, removed its quit handler, destroyed the window and called `app.exit(1)`. Three problems followed:

- The person was told nothing. The window disappeared.
- The exit skipped the ordinary quit. The ledger was not closed, so no clean-shutdown record was written and the next launch checked every index ([ADR 0147](./0147-one-process-owns-the-ledger-and-an-unclean-close-checks-every-index.md)). Running collections were aborted but not awaited, so a commit in flight could end as commit outcome unknown ([ADR 0056](./0056-commit-attempt-is-the-authority-for-commit-outcome.md)).
- The renderer could end the App. It called `automation:fatalRuntimeSnapshot` whenever it could not read a runtime snapshot or threw while accepting one.

A fourth gap sat beside them. When the PGlite worker supervisor gave up mid-session, after a fourth crash within a minute, with an error that was neither a failed restore nor an unusable ledger, nothing handled it. The App kept running on a dead ledger, and every ledger call failed. A worker that never opened at startup did reach the fatal exit, through the readiness it rejected.

## Decision

These failures still end the App, as ADR 0150 requires. They now explain first and end through the ordinary quit.

- **One fatal path.** A fatal report stops the schedules for good, refuses new collections and stops the running ones, so nothing starts while the dialog is open. It brings the App to the front. Then it shows one native dialog in Traditional Chinese or English, by the system language. The dialog says that OctopusBeak must close because of an internal problem and that collected data was not changed by it. It names the fatal stage and code for a report, and has one button, which quits. It never shows an error message, a path or a stack.
- **The ordinary quit, with status 1.** After the dialog closes, the App runs the same bounded quit as any other: cleanup, then the ledger close, each within its existing wait. The exit that ends a fatal quit has status 1. If the dialog cannot be shown, the quit runs anyway.
- **Handled once.** A second fatal report while the first is handled changes nothing. So does a report while ledger recovery is asking, while a restore is swapping back, or after a quit has begun.
- **A supervisor give-up is fatal.** One route handles both a startup failure and a give-up: a restored backup that did not open goes back ([ADR 0157](./0157-a-cleanup-backup-is-restored-by-swapping-folders-at-launch.md)), an unusable ledger asks the person (ADR 0150), and anything else takes the fatal path at the stage `ledger-worker`.
- **The renderer cannot end the App.** The `automation:fatalRuntimeSnapshot` channel is removed. When the renderer cannot read or accept a runtime snapshot, it reloads the window. If the reloaded page fails again before it accepts any snapshot, it shows an error state with a retry and stops reloading by itself. Session storage records the reload; when it cannot, the page shows the error state at once instead of risking a loop. The host stays up, and a running collection continues.

## Considered options

- **Keep the renderer-triggered exit.** A view that is out of step with the host would fail closed ([PRODUCT.md](../../PRODUCT.md), principle 4). Rejected. A renderer exception ended a collection in flight. The host already reports its own snapshot failures, so the renderer's report acted alone only when the renderer was the broken side, and a reload repairs that side. The host admits every start ([ADR 0128](./0128-a-task-run-starts-through-one-admission-with-no-await-before-its-claim.md)), so a stale page cannot start a second run.
- **Keep the direct `app.exit(1)` and add the dialog before it.** Rejected. It explains, but still skips the ledger close and orphans running collections.

## Consequences

- After a fatal report, the next launch finds a clean-shutdown record when the ledger closed within its bound, and skips the full index check.
- A fatal quit takes up to the ordinary quit's bound after the dialog closes, instead of ending at once.
- Development fixtures skip the dialog, since no one is there to close it, and still exit with status 1.
