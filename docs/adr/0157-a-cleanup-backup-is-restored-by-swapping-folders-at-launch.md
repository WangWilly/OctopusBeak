# A cleanup backup is restored by swapping folders at launch

Status: accepted

Builds on [ADR 0156](./0156-one-cleanup-action-compacts-then-reclaims.md) and [ADR 0150](./0150-an-unusable-ledger-asks-to-retry-or-rebuild.md).

ADR 0156 takes a Cleanup Backup before every cleanup and keeps it for 60 days, but the App could not use it: a person had to quit and swap two folders by hand. A backup a person cannot use protects nobody.

**A person can restore the Cleanup Backup: the App restarts, and at launch the main process puts the backup in the ledger's place before the worker opens it.** This is the Cleanup Restore of `CONTEXT.md`.

## Where it starts

- **Settings.** While a backup exists and can be restored, the cleanup row has "Restore". The dialog is titled "Restore the ledger backed up before the cleanup on *date*?" and says: "Collected financial data and manual assets go back to their state at the backup. Data added since is lost. OctopusBeak restarts to finish the restore." One destructive button, "Restore and restart"; no typed confirmation. The main process refuses while a cleanup or a reset runs.
- **The unusable-ledger dialog of ADR 0150** gains "Restore the backup from *date*" when a restorable backup exists. It moves the unusable ledger to `.damaged-<time>`, as "Back up and rebuild" does, and puts the backup in its place.

A backup can be restored when the file beside it records this App's canonical and operational baseline versions (ADR 0156). The main process reads that file itself, so the check works with no worker.

## The swap

The worker opens the ledger as soon as the App starts, and nothing can replace an open store's folder. So the request only records an intent, and the swap runs at the next launch.

1. **Request.** The main process stops collection, writes `<ledger>.restore-pending` naming the backup, flushes it, and restarts through the ordinary quit, which closes the ledger cleanly.
2. **At launch, before the worker starts,** the main process reads the file. If the backup it names is still a finished backup beside the ledger, it renames the ledger to `<ledger>.replaced-<time>`, renames the backup to the ledger, removes the ledger's clean-shutdown record, and records in the file that the swap is done. A backup is a copy of a running store, so the open that follows checks every index (ADR 0147), as after an unclean close.
3. **The open decides.** Once the worker reports ready, the main process removes the replaced ledger, the backup's versions file and the pending file. If the worker cannot open the store, for any reason, the main process renames the folders back, records the failure, and restarts once more with the ledger the person had.

Each step is a rename or a flushed write of the pending file, and the launch step reads the file and the folders that exist to find where it stopped, so a crash between any two steps is finished or undone at the next launch. The restore from the unusable-ledger dialog has nothing to go back to: a backup that does not open there shows that dialog again.

## After it

- **The backup is used up.** The ledger is the backup now; the row shows no backup. Restoring twice would need a copy, and a copy on a disk that cannot clone would need the room the person may not have.
- **The replaced ledger is removed once the restore opens.** Keeping it would be a second backup with a second restore, and the dialog already said what is lost.
- **Settings says "The ledger is back to its state on *date*."** once, after the restart; or that the backup could not be restored and the ledger is unchanged.
- **The cleanup offers its work again.** The restored ledger holds the redundant data the cleanup had removed.
- **Schedules run as the restored ledger says.** A run recorded after the backup is no longer recorded, so a schedule collects again, which also brings back what the restore lost from the sources. Nothing announces it.
- **The Card identity secret is not checked first.** If it changed since the backup, the open asks for a Canonical Reset of the card namespaces, as it does for any ledger that holds accounts from another secret (ADR 0149).
- **A Canonical Reset already removed the backup** (ADR 0156), so a restore cannot bring back financial data a person deleted.

The box's tooltip now reads: "The backup can be restored if something goes wrong. It takes about *N* MB and can be safely deleted once things are stable."

## Considered options

- **Swap the folders while the App runs, restarting only the worker.** Rejected. Every live view, the data-version counter and the schedulers hold state read from the old ledger; a restart is the one path that resets all of them, and ADR 0150 already restarts this way.
- **Copy the backup into place and keep it.** Rejected, as above: it doubles the disk need to allow a second restore of the same state.
- **Keep the replaced ledger for 60 days too.** Rejected. Two folders, two directions of restore, and two expiry dates to explain.
- **Refuse when the Card identity secret changed.** Rejected. It needs the Keychain to have failed inside the 60 days, and the open already handles it without damage.

## Consequences

- A restore loses everything entered or collected since the cleanup. Sources give their part back on the next sync; manual assets, categories and pairings a person set do not come back.
- A backup taken before an update that changed a baseline version cannot be restored, and the row says so instead of offering it.
- An open failure that is not the index refusal of ADR 0150 still exits the App when no restore is pending; only a pending restore turns it into a swap back.
