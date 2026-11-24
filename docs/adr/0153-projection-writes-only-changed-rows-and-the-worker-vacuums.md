# The projection writes only changed rows, and the worker vacuums

Status: accepted

Amends the current-projection refresh of [ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md) and the PGlite worker of [ADR 0030](./0030-pglite-owned-live-financial-views.md).

PGlite runs Postgres as one backend with no autovacuum. Every row an UPDATE or DELETE replaces stays in its table as a dead tuple until a VACUUM runs, and nothing ran one.

Each commit refreshed the current projection for every transaction in its capture. The refresh deleted those transactions' rows and inserted them again, even when nothing about them had changed. A daily re-sync of an unchanged statement therefore left one dead copy of each row in five tables: `current_transactions`, `current_transaction_enrichment`, `current_spending_pairing_entries` (through its trigger), `projection_generation_transactions` and `projection_generation_transaction_selection`. A probe committed the same 200-row card capture 365 times. Those five tables then held 77 MB of dead tuples for 200 live rows, about a fifth of the store's growth.

**The refresh writes only the rows whose values change.** It still selects the same rows for the same transactions and runs every derivation it ran before: enrichment, Kinds and the categories they derive ([ADR 0141](./0141-interest-and-fees-is-a-personal-category-spending-and-cash-flow-share.md)), with the unchanged-Kind rule of [ADR 0144](./0144-a-store-removes-derived-kinds-a-refresh-wrote-again-unchanged.md), and the copies into the active generation. Each projection table it writes per transaction is then brought to that selection in one statement; so is the generation copy a note or display-name edit refreshes. A row whose key is no longer selected is deleted, a row whose values differ is updated in place, and a new key is inserted. A row whose values are equal is not touched, so it leaves no dead tuple and fires no trigger.

- **A row's projection commit is the commit that last changed it.** `projection_commit_id`, and `commit_id` on `current_transactions`, used to name the latest refresh. They now name the commit whose refresh last wrote a different value. A knowledge-time read such as `commit_sequence <= ?` sees an unchanged row from the commit that first produced it, which is when that value became known.
- `current_projection_state` and `projection_generations` still record every refresh.

**The worker vacuums the tables that need it.** `startPgliteVacuums` runs on the background lane of the worker scheduler, beside the WAL checkpoints, and stops with them.

- **Once after open,** five seconds in, it vacuums every table, smallest first, each as its own task on the queue so other queued work runs between two tables. PGlite writes no statistics file when it closes, not even a clean close, so every table reopens with `n_dead_tup` at 0. Without this pass, dead tuples from earlier sessions would be reclaimed only once new ones pushed a table past the threshold, a short session would never vacuum, and a table gaining 50 or fewer dead tuples a session would grow forever. On a 330 MB store the pass took 1.5 s in all the first time and 0.6 s on the next open, mostly ANALYZE sampling; the longest single table took 220–480 ms.
- **Every minute after that,** it reads `pg_stat_all_tables` and vacuums each table whose dead tuples exceed autovacuum's default threshold: 50 plus a fifth of its live rows. System catalogs count. Each live-view subscription creates and drops a temporary view, which leaves dead tuples in `pg_depend`, `pg_type`, `pg_class`, `pg_rewrite` and `pg_attribute`, and every ANALYZE rewrites `pg_statistic`. TOAST tables are vacuumed with their owners, and temporary schemas are skipped. A table that fails is reported, and the rest are still vacuumed.
- Both passes give a store table `VACUUM (ANALYZE)` and a catalog plain `VACUUM`. A plain VACUUM records a table's current page count and keeps its old statistics. `refreshPlannerStatistics` reads that page count as the size the statistics describe, so after a plain VACUUM it would analyze a grown table only once it grew another tenth. A store growing less than that each session would never have its projection join tables analyzed again.
- PGlite does report `n_dead_tup`. A backend publishes its counts at most once a second, after a statement ends, so the step calls `pg_stat_force_next_flush()` before reading them.
- Plain VACUUM keeps a table bounded in PGlite. It frees the dead tuples' space for the table's next writes. It takes an exclusive lock only briefly, to cut empty pages from the end of a table. The same 200-row capture, re-synced 365 times on the old refresh with a VACUUM every ten commits, kept the five projection tables at about 3 MB instead of growing past 75 MB. A pass took about 30 ms.
- The step catches what the refresh change does not remove: `source_record_scopes` rows a re-sync updates, the per-account rows refreshed on every capture, and rows an aborted transaction left behind.

## Considered options

- **Refresh only the transactions whose canonical state changed.** Rejected. A transaction's Kind reads relations outside its own revision: credit-card statements, loan settlement groups and investment funding. Re-deriving every transaction in a capture is what lets a re-sync pick up a relation that changed elsewhere. Narrowing the set would need every such dependency to name the transactions it affects, and a missed one would leave a Kind stale with no error.
- **VACUUM FULL.** Not needed. Plain VACUUM keeps the tables at their working size. VACUUM FULL rewrites each table under an exclusive lock that blocks every read; on a 330 MB store it took about 4 seconds. [ADR 0155](./0155-a-manual-reclaim-rewrites-bloated-ledger-tables.md) adds it as a manual Settings action, one table at a time, to return space lost before this decision.
- **Vacuum after each sync run, or after a number of commits.** Not needed. A dead-tuple threshold read every minute covers both, and also catches writes that come from neither.
- **Vacuum in `close()`, before the clean-shutdown marker.** Rejected. It would lengthen every quit, and a crash would skip it. The pass after open also covers a store that last closed uncleanly.

## Consequences

- An unchanged re-sync writes no projection row. The five tables stayed at 0.65 MB across 365 syncs of the probe capture.
- A table vacuumed by plain VACUUM stays near its peak size on disk. It shrinks only by the empty pages at its end, and it does not grow while its live rows stay the same.
- Every open costs a VACUUM and ANALYZE of every store table on the background lane, under a second on a 330 MB store, one table at a time.
