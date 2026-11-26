# An unusable ledger asks to retry or rebuild

Status: accepted

Amends [ADR 0147](./0147-one-process-owns-the-ledger-and-an-unclean-close-checks-every-index.md).

ADR 0147 made a ledger whose corrupt index cannot be rebuilt, or whose indexes cannot be checked, refuse to open. The refusal reached the automation runtime's startup reconciliation as a fatal error, and the App exited without a word on every launch.

**The App now asks the person what to do.**

- The worker reports the refusal with the code `ledger-indexes-unrepairable`, and the worker client rejects its readiness with that code.
- Startup waits for the ledger to open before it reconciles the automation runtime. When the ledger refuses, startup shows a native dialog instead of ending the App. Other fatal reports do not end the App while the dialog is open.
- A worker that the supervisor restarts mid-session after a crash checks the ledger again. If it refuses, the same dialog opens, and any running collection is aborted.
- The dialog explains that opening the ledger anyway could collect the same transaction twice. It offers three buttons:
  - **Retry** starts the App again. A refused ledger leaves no clean-shutdown record, so the new start checks and tries to repair it again. The dialog says this only helps if the problem was temporary.
  - **Back up and rebuild** moves the whole data directory aside, untouched, to `pglite.damaged-<UTC time>` beside it, and starts the App again. The new start creates an empty ledger, and the person syncs each source again. If the move fails, an error dialog names the path and the reason, nothing changes, and the App quits.
  - **Quit** ends the App and changes nothing. Closing the dialog quits too.
- Before the person chooses, the dialog names the backup path and what a rebuild loses: anything entered or edited in the App, such as manual assets, tags, spending categories and pairings, and history older than what each source still provides. These stay only in the backup.
- The dialog follows the system language: Traditional Chinese or English.

Other refusals to open, such as a schema that does not match its manifest, still end the App as before. Rebuilding would hide an App defect behind lost data.

## Considered options

- **A recovery page inside the App.** Rejected. Much of the renderer assumes a ledger exists, so a page without one would touch many routes. A dialog before anything reads the ledger is small and reliable.
- **Delete the damaged ledger on rebuild.** Rejected. Moving it aside costs only disk space, and keeps manual data recoverable by hand or with later tooling.
- **Salvage the readable tables into the new ledger.** Not now. A partial copy could carry the damage forward, and it needs its own design.

## Consequences

- A backup stays until the person removes it or runs a Canonical Reset, which deletes it with the rest of the financial data, the hand-entered data only it holds included ([ADR 0156](./0156-one-cleanup-action-compacts-then-reclaims.md)). Nothing lists it in the App yet.
- Data recorded only in the App, and history the sources no longer serve, is not restored automatically after a rebuild.
