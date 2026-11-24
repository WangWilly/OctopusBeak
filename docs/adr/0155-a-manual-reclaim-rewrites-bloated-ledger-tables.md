# A manual reclaim rewrites bloated ledger tables

Status: accepted

Amends [ADR 0153](./0153-projection-writes-only-changed-rows-and-the-worker-vacuums.md).

ADR 0153 stopped the ledger from growing: the projection writes only changed rows, and the worker runs a plain VACUUM after open and on a dead-tuple threshold. A plain VACUUM frees a dead tuple's space for the table's next writes. It does not give that space back to the disk. A store written before ADR 0153 therefore keeps its peak size.

One person's ledger measured 1,676 MB. The space sits in three places:

- **The system catalogs, 583 MB.** Each live-view subscription creates and drops a temporary view, with its rule, type, columns and dependencies, so `pg_depend`, `pg_class`, `pg_type`, `pg_attribute` and `pg_rewrite` churn on every subscribe and unsubscribe. A catalog keeps few live rows, and plain VACUUM keeps its heap small. Its B-tree indexes keep every page they ever split into. In a synthetic store, 20,000 subscriptions left `pg_depend` at 7.97 MB, mostly index pages, for under 2,000 live rows.
- **The projection tables, about 190 MB.** Before ADR 0153 every commit rewrote every row of its capture. `current_transaction_enrichment` held 80 MB for 582 rows.
- **`automation_task_runs`, 60.8 MB for 294 rows.** Every stage event rewrites a run's whole record, which lives mostly in TOAST.

**Settings has a "Reclaim ledger space" action that runs `VACUUM FULL` on the tables that need it.** `VACUUM FULL` writes a table's live rows, its TOAST and its indexes into new files, then deletes the old files. No row is deleted or changed. The action first shows about how much it can reclaim, then which table of how many it is rewriting, then what it reclaimed.

- **Tables are picked by size.** A table, catalogs included, is picked when its rewrite would free at least 1 MiB and at least a quarter of its size. The estimate reads every live row of each table of 1 MiB or more: the rows' size, packed into pages, gives the heap and TOAST a rewrite would leave. One B-tree entry per row, built from the indexed columns' average sizes, gives each index. Dead-tuple counts cannot pick the tables. PGlite keeps no table statistics across a close, so `n_dead_tup` reads 0 after every open, and the worker's plain VACUUM has already removed the dead tuples whose space is left. The counts never cover TOAST either. PGlite 0.5 does not ship `pgstattuple`.
- **One table per step, smallest first.** Each estimate read and each rewrite is its own step on the worker's background lane (`scheduleStep`). PGlite runs one statement at a time, so every query waits while a table is rewritten, but a click, a page read or a commit queued meanwhile runs before the next table.
- **Syncs and commits queue; nothing is cancelled.** A commit is one job on the same queue, and `VACUUM FULL` cannot run inside a transaction, so a rewrite never overlaps a commit. A sync running during a reclaim waits at most one table's rewrite for each commit. A reclaim does not pause schedules. Unlike the delete actions in the same section, it does not cancel running syncs, because it changes no data a sync would race with.
- **The disk is checked first.** A rewrite writes a table's new copy before it deletes the old one, and its WAL holds the new copy once more. The reclaim refuses before it starts unless the disk has twice the largest new copy free, plus 64 MB. It reports the space it needs and the space that is free.
- **Stop works between tables.** The table being rewritten finishes first. A rewrite that fails stops the reclaim; the tables already rewritten stay reclaimed.
- **A checkpoint ends it,** so the rewrites' WAL is not replayed after a crash.
- **Host-only.** The four worker operations have no renderer route and no workflow access. The renderer reaches them through the Settings desktop service, which forwards sizes and counts only.

Catalog `VACUUM FULL` needs nothing special in PGlite 0.5.8. `pg_class`, `pg_attribute` and `pg_type` are mapped catalogs: the relation map, not `pg_class`, names their files, so a rewrite updates the map. It runs as a plain statement outside a transaction, like any other `VACUUM FULL`. A check rewrites every table and catalog of a churned store, reopens it, and finds every B-tree index clean with the check of [ADR 0147](./0147-one-process-owns-the-ledger-and-an-unclean-close-checks-every-index.md). Live queries still subscribe and still hear writes, and every table's rows hash the same.

On a synthetic 385 MB store built like a pre-ADR 0153 ledger, the estimate took 1.1 s and picked 11 tables. The reclaim took 1.9 s and left the store at 72 MB. The longest rewrite, `current_transaction_enrichment` from 103 MB to 1.1 MB, held the ledger for 237 ms. `npm run check:pglite-reclaim` rebuilds that store and reports the same figures.

## Considered options

- **Run `VACUUM FULL` automatically, after open or on a threshold.** Rejected. A rewrite locks the whole ledger for as long as it takes to copy the table's live rows, which grows with the store. The worker cannot know when the person is in the middle of something, and the waste is mostly a one-time cost of writes before ADR 0153. Live-view churn still bloats catalog indexes slowly, so the action stays useful and the person decides when.
- **Rewrite the whole store in one step.** Rejected. Interactive work would wait for every table instead of one.
- **Cancel running syncs first, as the delete actions do.** Rejected. A reclaim changes no data, and the queue already keeps a rewrite from overlapping a commit.
- **Rebuild only the indexes, with `REINDEX`.** Not enough. It would shrink the catalogs' indexes but not the projection tables' heaps or the task runs' TOAST.

## Consequences

- A store written before ADR 0153 can return most of its size without deleting anything. The owner's ledger should shrink by about 750 MB.
- During a reclaim the app pauses for the length of one table's rewrite at a time. The copy says so.
- The estimate reads every row of each table of 1 MiB or more, one table per step, so opening the action on a large store takes a second or more.
