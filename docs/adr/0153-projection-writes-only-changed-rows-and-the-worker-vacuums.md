# The projection writes only changed rows, and the worker vacuums

Status: accepted

Amends the current-projection refresh of [ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md) and the PGlite worker of [ADR 0030](./0030-pglite-owned-live-financial-views.md).

PGlite runs Postgres as one backend with no autovacuum. Every row an UPDATE or DELETE replaces stays in its table as a dead tuple until a VACUUM runs, and nothing ran one.

Each commit refreshed the current projection for every transaction in its capture. The refresh deleted those transactions' rows and inserted them again, even when nothing about them had changed. A daily re-sync of an unchanged statement therefore left one dead copy of each row in five tables: `current_transactions`, `current_transaction_enrichment`, `current_spending_pairing_entries` (through its trigger), `projection_generation_transactions` and `projection_generation_transaction_selection`. A probe committed the same 200-row card capture 365 times. Those five tables then held 77 MB of dead tuples for 200 live rows, about a fifth of the store's growth.

**The refresh writes only the rows whose values change.** It still selects the same rows for the same transactions and runs every derivation it ran before: enrichment, Kinds and the categories they derive ([ADR 0141](./0141-interest-and-fees-is-a-personal-category-spending-and-cash-flow-share.md)), with the unchanged-Kind rule of [ADR 0144](./0144-a-store-removes-derived-kinds-a-refresh-wrote-again-unchanged.md), and the copies into the active generation. Each projection table is then brought to that selection in one statement. A row whose key is no longer selected is deleted, a row whose values differ is updated in place, and a new key is inserted. A row whose values are equal is not touched, so it leaves no dead tuple and fires no trigger.

- **A row's projection commit is the commit that last changed it.** `projection_commit_id`, and `commit_id` on `current_transactions`, used to name the latest refresh. They now name the commit whose refresh last wrote a different value. A knowledge-time read such as `commit_sequence <= ?` sees an unchanged row from the commit that first produced it, which is when that value became known.
- `current_projection_state` and `projection_generations` still record every refresh.

**The worker vacuums the tables that need it.** Every minute, on the background lane of the worker scheduler, `startPgliteVacuums` reads `pg_stat_user_tables` and runs `VACUUM (ANALYZE)` on each table whose dead tuples exceed autovacuum's default threshold: 50 plus a fifth of its live rows. The step runs beside the WAL checkpoints and stops with them.

- PGlite does report `n_dead_tup`. A backend publishes its counts at most once a second, after a statement ends, so the step calls `pg_stat_force_next_flush()` before reading them.
- Plain VACUUM keeps a table bounded in PGlite. It frees the dead tuples' space for the table's next writes and takes no exclusive lock. The same 200-row capture, re-synced 365 times on the old refresh with a VACUUM every ten commits, kept the five projection tables at about 3 MB instead of growing past 75 MB. A pass took about 30 ms.
- ANALYZE comes with it because VACUUM records the table's current page count, which `refreshPlannerStatistics` reads as the size its statistics describe.
- The step catches what the refresh change does not remove: `source_record_scopes` rows a re-sync updates, the per-account rows refreshed on every capture, and rows an aborted transaction left behind.

## Considered options

- **Refresh only the transactions whose canonical state changed.** Rejected. A transaction's Kind reads relations outside its own revision: credit-card statements, loan settlement groups and investment funding. Re-deriving every transaction in a capture is what lets a re-sync pick up a relation that changed elsewhere. Narrowing the set would need every such dependency to name the transactions it affects, and a missed one would leave a Kind stale with no error.
- **VACUUM FULL.** Not needed. Plain VACUUM keeps the tables at their working size. VACUUM FULL rewrites each table under an exclusive lock that blocks every read; on a 330 MB store it took about 4 seconds.
- **Vacuum after each sync run, or after a number of commits.** Not needed. A dead-tuple threshold read every minute covers both, and also catches writes that come from neither.

## Consequences

- An unchanged re-sync writes no projection row. The five tables stayed at 0.65 MB across 365 syncs of the probe capture.
- A table vacuumed by plain VACUUM keeps its peak size on disk. It does not shrink, but it does not grow while its live rows stay the same.
- Statistics survive a clean shutdown but are reset by a crash. Dead tuples left before a crash are vacuumed only after new writes push the table past the threshold again.
