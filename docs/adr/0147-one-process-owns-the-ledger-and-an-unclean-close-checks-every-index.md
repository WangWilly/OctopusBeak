# One process owns the ledger, and an unclean close checks every index

Status: accepted

Supersedes [ADR 0029](./0029-cross-process-canonical-writer-lease.md).

ADR 0029 coordinated several processes writing one SQLite ledger through a sidecar lease. The PGlite ledger replaced that store, and the lease went with it. One PGlite worker in the main process owns the data directory ([ADR 0030](./0030-pglite-owned-live-financial-views.md)), and the supervisor closes a dead worker before the next one opens it. Nothing stopped a second app process from opening the same directory. PGlite holds its buffers and WAL position in memory, so two processes writing one directory can tear its indexes. A torn `pg_depend` index has already broken live views.

**One process owns userData.** `main.ts` takes Electron's single-instance lock right after it sets the userData path. A second process on the same userData quits before it opens the ledger or `credentials.json`, and the first process brings its window forward. A development build without `OCTOPUSBEAK_USER_DATA` shares the installed app's userData, so it quits while the installed app runs. Scripts that open a PGlite store use a disposable directory and take no lock.

**An unclean close checks every B-tree index before the store opens.** A clean close writes `pglite.clean-shutdown` beside the data directory. Opening removes it first, so a crash or a forced worker termination leaves none. When it is absent, the worker runs `bt_index_check` with `heapallindexed` on every persistent B-tree index, catalog and ledger alike. A ledger index matters as much as a catalog index: a commit looks up identities through `UNIQUE` indexes, and a lookup that misses a row admits it again.

- Every corrupt index, and every invalid one, which amcheck cannot check, is rebuilt with `REINDEX INDEX`. When amcheck cannot even be installed, the catalog is rebuilt with `REINDEX SYSTEM`. Then every index is checked again, and the repair counts only if that check is clean.
- **The store does not open** when a corrupt index cannot be rebuilt, or when the check cannot run. Rebuilding a unique index fails when its table already holds a duplicate. The worker reports the reason as a start failure, and the next open checks again.
- A store that closed cleanly opens without the check.

## Considered options

- **A lock file in the data directory.** Rejected. Node has no advisory file lock, so a PID lock file needs stale detection, and a reused PID after a crash would lock the person out of their ledger. Electron's lock handles stale owners already, and no other process opens the person's own directory.
- **Check on every open, as the first repair did.** Rejected. Each check writes the catalog to install and drop `amcheck`, and it reads every index. A clean close gives no reason to suspect corruption.
- **Log a failed repair and open anyway, as the first repair did.** Rejected. Commits would run through the broken index and could admit duplicates silently.

## Consequences

- The first open after this change checks once, because no store has the record yet.
- A store with a duplicate behind a broken unique index does not open until someone repairs it by hand. There is no in-app recovery yet.
- A worker that misses its shutdown bound and is terminated leaves no record, so the next open checks.
