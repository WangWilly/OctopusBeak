# One cleanup action compacts, then reclaims

Status: accepted

Amends the Settings parts of [ADR 0154](./0154-compaction-removes-the-copies-and-repeats-an-unchanged-re-sync-no-longer-writes.md) and [ADR 0155](./0155-a-manual-reclaim-rewrites-bloated-ledger-tables.md). The compaction, its chunks and guards, and the reclaim's rewrite are unchanged.

Settings had two rows, "Compact ledger" and "Reclaim ledger space". A person had to know that one deletes repeated copies and the other only rewrites tables, run them in that order, and run the second again because the compaction reclaimed only the tables it had changed. The person wants one result: a smaller ledger.

**Settings has one action, "Clean up app data" (「清理應用資料」), the App Data Cleanup of `CONTEXT.md`.** It runs the compaction when the ledger still holds removable rows, then the reclaim over every table the reclaim would pick, catalogs included. Once the compaction's markers are written, the same action only reclaims, and the space marker no longer skips the reclaim. A store with a citation the planner does not know, which every chunk would refuse, is not compacted either: the action only reclaims and writes no compaction marker. The two old rows, their operations' renderer routes and the reclaim's own worker operations go; one host-only operation, `financial.ledger.cleanupEstimate`, reads the estimate, and the dry run is no longer an operation of its own.

## The estimate and the confirmation

- **One figure.** The action runs both estimates when the person asks, never on its own: the dry run can hold the ledger for seconds per source. It shows "*N* MB of data can be safely removed. Your accounts, transactions, statements, categories and settings do not change." *N* is the compaction's removable bytes plus the reclaim estimate. A tooltip on *N* splits it: "Redundant sync data" (the compaction) and "Temporary app data" (the reclaim). Both are estimates; the result reports what the folder lost.
- **The copy does not say what is deleted.** It says what does not change, which is what the readers' digests prove. With nothing to remove the action says so and does not start.
- **Room is checked before anything is deleted.** The reclaim needs three new copies of its largest table plus 64 MB (ADR 0155). Before the run, that table's size after the compaction is known: its live bytes less the bytes the dry run would remove. The tables counted are the ones the reclaim's own rule (1 MiB and a quarter of the table) would pick once the removed rows are dead space. Without a backup the action needs that figure. With a backup it needs that figure plus `ledgerBackupBytesNeeded`, the sum and not the larger, because the backup stays on the disk while the reclaim runs: a byte copy has already used the folder's size, and a clone keeps the old blocks of every table the reclaim rewrites. One rule, `cleanupBackupBytesNeeded`, decides both the estimate and the backup's own check before it copies; that check takes the run's need from the estimate the owner confirmed while nothing has been written to the store since that estimate began, and reads the estimate again otherwise, or when the worker has none. When the sum does not fit but the figure alone does, the run goes without a backup. With less free space than the figure it does not start and says how much it needs. The estimate is taken before the compaction, which only removes as much or more, so the need is not understated. A disk that fills during the run can still stop the reclaim; the result then says that the redundant data is removed and how much space is still to be returned.

## The backup

- **Taken whenever it fits.** With room for it the run starts with the Cleanup Backup, as ADR 0154 describes, whether or not the run will delete rows. Without room there is no backup: the box is disabled, a warning says why, and the person can still clean up. The same holds when the room for a backup could not be read.
- **"Keep the backup for 60 days", ticked.** Unticked, the backup is removed as soon as the run ends as done. The worker's request says whether to keep it; a request that does not say keeps it, and Settings always says. A run whose reclaim found no room counts as done here: its redundant rows are removed and verified, and the backup would hold the room the reclaim needs. A run that failed or was stopped keeps it. Ticked, it stays for 60 days from the time in its name, and the worker removes an expired backup when it opens the store, beside the removal of partial copies.
- **At most one.** A run that takes a new backup removes the earlier one once the new one is whole. A backup is removed by renaming it to `.partial` first, so a removal cut short leaves a copy the next open removes, never a half-deleted folder under a backup's name. Backups the earlier opt-in action of ADR 0154 took follow the same rules: they expire 60 days from the time in their name, and a new backup replaces them.
- **The row shows it.** While a backup exists the row shows its size and the day it expires, a small icon that reveals it in Finder, and "Delete backup". The main process reveals and deletes, and refuses to delete while a cleanup runs; the renderer still gets no path, only that a backup exists, its size, its time and whether it can still be restored. A backup whose size cannot be read is shown without it and can still be deleted.
- **It records the store's versions.** A file beside the backup, `<backup>.versions.json`, holds the canonical and operational baseline versions of the store it copied, written before the backup gets its name. A backup without one, as one taken before this ADR, counts as one that can no longer be restored. The open refuses a store of another baseline version, so a backup taken before an update that changed one can no longer be opened; the row then says "This backup can no longer be restored and can be deleted."
- **A Canonical Reset removes it.** Canonical Deletion Completion means deleted financial data is unreachable from every recovery path. A Cleanup Backup left after a reset would hold it, so the reset deletes the backup, partial copies included, before it empties the store. An unusable ledger moved aside as `.damaged-<time>` (ADR 0150) holds the same data, so the reset deletes those folders too; "Reset ledger" says so under its financial-data option. A removal that fails fails the reset and leaves the store as it was, so the person can run it again.

Restoring a Cleanup Backup is a later decision with its own ADR. Until then the box's tooltip says the backup can replace the ledger folder if something goes wrong, and makes no promise of a restore action.

## The run

- **A dialog that cannot be closed** covers the App during the run, with a progress bar and Stop. The steps hold the ledger for up to about ten seconds each on a 2 GB store; an App that answers between them and freezes during them looks broken, and a minute's wait does not. The bar has three parts: the backup, with no known length; the compaction, step *i* of *n*; the reclaim, table *i* of *n*.
- **Stop and resume are as before.** Stop ends the running chunk or lets the table being rewritten finish. Settings opened again during a run shows the dialog again.
- **Four results.** Done, with the megabytes freed. Stopped, with the megabytes freed so far and that cleaning up again continues. Failed: the failed step was rolled back, the data is unchanged, and the megabytes freed before it when there are any. Backup failed: nothing was removed, with "Try again" and "Clean up without a backup".

## Considered options

- **Keep two rows and chain them.** Rejected. The person would still read two descriptions to press one button.
- **Two confirmations, one per phase.** Rejected. It is the two rows again inside one flow.
- **Offer to remove only the redundant data when the reclaim has no room.** Rejected. The disk would be as full as before and the person would see no result.
- **Keep the backup until the person deletes it.** Rejected with the default now on: every person would lose the ledger's size in disk space without having chosen to. A fixed term keeps the protection for the time a problem would show.
- **Delete the backup from the reset dialog.** Rejected. Removing a backup frees space; the reset dialog holds only choices that delete a person's data.
- **Tell the person when there is much to clean up.** Rejected. Knowing needs the estimate, which pauses the App.

## Consequences

- The first cleanup of a store written before ADR 0152 deletes rows under copy that never says "delete". The guards of ADR 0154 are what make the sentence true, and the backup is the answer when they are wrong.
- The App cannot be used during a cleanup: about a minute on the owner's 2 GB ledger.
- A person short of disk space cannot clean up at all until they free the room the reclaim needs.
