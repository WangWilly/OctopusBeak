# A cleanup backup is restored by swapping folders at launch

Status: accepted

Builds on [ADR 0156](./0156-one-cleanup-action-compacts-then-reclaims.md) and [ADR 0150](./0150-an-unusable-ledger-asks-to-retry-or-rebuild.md).

ADR 0156 takes a Cleanup Backup before every cleanup and keeps it for 60 days, but the App could not use it: a person had to quit and swap two folders by hand. A backup a person cannot use protects nobody.

**A person can restore the Cleanup Backup: the App restarts, and at launch the main process puts the backup in the ledger's place before the worker opens it.** This is the Cleanup Restore of `CONTEXT.md`.

## Where it starts

- **Settings.** While a backup exists and can be restored, the cleanup row has "Restore". The dialog is titled "Restore the ledger backed up before the cleanup on *date*?" and says: "Collected financial data and manual assets go back to their state at the backup. Data added since is lost. OctopusBeak restarts to finish the restore." One destructive button, "Restore and restart"; no typed confirmation. The main process refuses while a cleanup or a reset runs.
- **The unusable-ledger dialog of ADR 0150** gains "Restore the backup from *date*" when a restorable backup exists. It moves the unusable ledger to `.damaged-<time>`, as "Back up and rebuild" does, and puts the backup in its place. The dialog only records the request, naming the `.damaged-` path its text showed; the launch step below makes both moves, so a crash between them is finished like any other. A request from Settings not yet carried out is replaced, so the unusable ledger is kept as damaged rather than removed as replaced. The dialog does not offer a backup that a swap back just gave back, since it opened and failed; a restore refused before its backup opened hides nothing. Settings cannot open while the ledger is unusable, so the dialog takes the restore's outcome itself, and nothing it read sticks. It writes the date in the time zone Settings uses.

A backup can be restored when the file beside it records this App's canonical and operational baseline versions (ADR 0156) and its folder holds a store (`PG_VERSION`), so an emptied folder never opens as a new, empty ledger. The main process reads both itself, so the check works with no worker.

## The swap

The worker opens the ledger as soon as the App starts, and nothing can replace an open store's folder. So the request only records an intent, and the swap runs at the next launch.

1. **Request.** The main process stops collection, writes `<ledger>.restore-pending` naming the backup, the time and the App version, flushes it, and restarts through the ordinary quit, which closes the ledger cleanly. The launch carries out only a request made within the last 24 hours; an older one, one dated in the future, or a malformed one moves nothing and counts as failed. The file also names the App version that asked, for diagnosis only: a restart that applies a downloaded update still carries the restore out, since the baseline versions are what decide whether the backup opens.
2. **At launch, before the worker starts,** the main process reads the file. If the backup it names is still a restorable backup beside the ledger, it renames the ledger to `<ledger>.replaced-<time>`, renames the backup to the ledger, removes the ledger's clean-shutdown record, and records in the file that the swap is done. A backup is a copy of a running store, so the open that follows checks every index (ADR 0147), as after an unclean close: no path opens the backup while a clean-shutdown record is beside it. After an error the folders decide, not which call failed, since a rename can land before its flush fails: a folder in the ledger's place with the backup's name free is a finished swap and goes on; anything else is moved back, trying again, and the restore counts as failed. A flush that fails after its rename landed does not fail the restore by itself. The launch never says the ledger is unchanged while the backup sits in its place, and when it can neither finish nor undo the swap it stops the App from starting rather than open a missing ledger.
3. **The open decides.** Once the worker reports ready, the main process renames the pending file to `<ledger>.restore-opened`, a signal that needs no free space, records the outcome, then removes the replaced ledger, the backup's versions file and that file. A clean close of the restored store, which writes its clean-shutdown record, is a second signal. A restore with either signal is never swapped back, even when nothing else could be written that session. What cannot be removed now is removed at a later launch, and never stops the App from starting. A restore that opens while an earlier one's file still names leftovers finishes the earlier one first and never renames over it. If the worker cannot open the store, for any reason, including a refusal that would otherwise end the App, the main process records that the folders go back and restarts once more; the next launch, again before the worker starts, renames them back, removes any clean-shutdown record so the person's own ledger checks every index, and records the failure. The swap back runs at launch rather than in the failing process, so nothing renames a folder a worker may still hold. A second failure, with the person's own ledger, is handled as without a restore. When the swap back cannot even be recorded, the App ends without starting itself again, so a disk that refuses every write cannot loop it. Only a failure the App saw and recorded swaps back; once the folders are back, a launch that still finds the file only retries removing it, and leaves the person's ledger and its clean-shutdown record alone.

What a person gets, case by case:

- The open reaches ready: the restore is done, whether or not anything could be written then.
- The open fails and the App sees it: one restart, then the ledger they had, and "could not be restored".
- The App dies with no signal either way (no opened file, no clean close, no recorded failure): the next launch opens the backup again. The restored ledger may have been in use, so it is never swapped out on a guess. Each launch that begins opening the backup adds one to a count in the pending file, written and flushed before the worker starts; a count that cannot be written does not count. Reaching ready ends the counting, and a clean close's record proves the open. Once two earlier launches began opening it with no word, the main process asks before the worker starts: "The restored backup has not finished opening after several tries", with "Try again" (the default), "Switch back to the original ledger" and "Quit"; closing the dialog quits. Its text says that switching back loses nothing: what was entered since the restore would be lost only if the person had been able to use the App since, and they have not. Switching back records `swap-back` and runs it in that same launch, since no worker exists yet; the backup is given back, can still be restored, and the outcome names it as one that would not open. Try again opens the backup once more; Quit changes nothing, and the next launch asks again.
- Ready reached, but every write of that session failed and the App then died: nothing records the open, so the count goes on and the third launch can ask. The person decides, and trying again, the default, keeps the restored ledger.
- Nothing is in the ledger's place: there is no ledger in use to lose, so the ledger they had goes back.

Each step is a rename or a flushed write, and the launch step reads the restore's files and the folders that exist to find where it stopped, so a crash or an error before or after any step is finished or undone at the next launch. The pending file holds bare names, each checked against the form its folder must have, so it can name nothing but the ledger's own siblings; a file that does not parse moves nothing and the restore counts as failed. The restore from the unusable-ledger dialog has nothing to go back to: a backup that does not open there shows that dialog again.

While a restore is pending, nothing that removes backups touches the one it names: not the expiry at open, not a new backup's removal of the earlier one, not the removal of stray versions files. Settings refuses a cleanup, a reset and a deletion of the backup once a restore is asked for and until the launch carries it out. A Canonical Reset removes every `.replaced-` ledger and the restore's files along with the backups, so no leftover of a restore keeps deleted financial data on the disk. Each launch also removes a `.replaced-` folder that no readable pending or opened file names, and a versions file whose backup is gone. Such a folder exists for a reason only while a file names it: a restore makes it with its file already written, and only that file can send it back. When a restore file cannot be read, that launch removes none.

## After it

- **The backup is used up.** The ledger is the backup now; the row shows no backup. Restoring twice would need a copy, and a copy on a disk that cannot clone would need the room the person may not have.
- **The replaced ledger is removed once the restore opens.** Keeping it would be a second backup with a second restore, and the dialog already said what is lost.
- **Settings says "The ledger is back to its state on *date*."** once, after the restart; or that the backup could not be restored and the ledger is unchanged. The main process keeps the outcome in `<ledger>.restore-outcome` and removes it when Settings reads it; the renderer gets only the outcome and the backup's time. Settings reads the backup through the main process, which checks the same versions file the launch step does.
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
