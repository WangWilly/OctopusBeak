# PGlite-owned live financial views

Status: accepted and implemented (direct cutover)

The desktop app will replace its canonical SQLite database with one PGlite
database owned by a dedicated database worker. This is a direct cutover, not a
long-lived SQLite/PGlite mirror or a Spending-only pilot. One database owner
allows automation writes, financial queries, and live subscriptions to observe
the same committed state without cross-process database leases. This decision
replaces the SQLite-specific storage and writer coordination in
[ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md),
[ADR 0017](./0017-canonical-schema-lifecycle.md), and
[ADR 0029](./0029-cross-process-canonical-writer-lease.md) at cutover; their
domain and transactional guarantees still apply unless explicitly revised.

The database worker owns schema initialization, transactions, allowed query
views, and subscriptions. Renderer windows and automation processes never open
the database directory independently. Electron main routes scoped commands
and subscription messages; preload exposes typed, limited APIs rather than a
PGlite instance or arbitrary SQL. Subscriptions are keyed by view and
parameters. For small aggregates, the worker sends complete `live.query()`
results; for keyed, larger ordered result sets it may send `live.changes()`
diffs. These are changes to a query result, not raw table-update events.
Within each renderer, one Svelte store per key shares the IPC subscription
among mounted consumers and tears it down when the last consumer leaves.
Existing synchronous SQLite calls are replaced by asynchronous domain queries
and commands at the worker boundary, not by a synchronous compatibility bridge
or a renderer-accessible general SQL proxy. Automation submits validated
captures to worker-owned transactional commands. Database interactions inside
one command may be reorganized to avoid a one-for-one port of the old SQL call
sites.

The open page updates from committed data automatically, replacing the
manual-only freshness behavior of [ADR 0027](./0027-versioned-manual-refresh-architecture.md)
at cutover. A manual reload remains available for recovery. Independent view
notifications may briefly expose adjacent generations; the renderer coalesces
arrivals into its next render, while database commands always validate their
preconditions inside a transaction. In the Spending pairing dialog, candidate
updates reorder the list immediately. Selection follows a stable candidate
identity, and is cleared with feedback if that candidate disappears or becomes
ineligible. Confirmation rechecks eligibility transactionally. Live UI
subscriptions replace neither historical financial-time/knowledge-time query
semantics nor write-side correctness checks.

The cutover uses a **manual, one-time command**, never an automatic app-start
migration. Existing schema migrations are consolidated into a PGlite baseline;
the command then transfers every irreducible financial fact and user-authored
record held in the SQLite databases, verifies their content and the behavior of
the new schema, and only then switches the app's database location. Disposable
projections and caches may instead be rebuilt and checked from those retained
records. SQLite tables and triggers may be consolidated or omitted when their
invariants and observable results are preserved; physical object-count parity
is not required. The command must report every intentionally rebuilt or
omitted object and reject an unclassified source object rather than silently
dropping it.
It preserves the source SQLite files whether the command succeeds or fails,
and does not silently discard records. New schema changes after the baseline
use new migrations. The
development data could be rebuilt, but that does not justify an implicit or
destructive cutover.

For the 2026-09-22 cutover, the user explicitly superseded the historical-data
transfer requirement above: all `canonical.sqlite` contents are disposable and
rebuildable. The implementation may initialize a fresh, versioned PGlite
baseline and leave both `canonical.sqlite` and `ledger.sqlite` untouched; it
does not need a one-time historical-data migration, content-parity check, or
SQLite rowid transfer. This decision does not authorize automatic startup
migration, weaken the baseline's write-side constraints and trigger
equivalents, or remove the requirement that later schema changes use reviewed
migrations. The legacy SQLite files remain available for inspection and are
not deleted by initialization.

This architecture preserves the pairing and interaction performance contract
in [ADR 0028](./0028-interaction-and-pairing-performance-contract.md),
including complete candidate coverage and transactional correctness.

## Cutover implementation and verification

The desktop runtime now opens only the worker-owned PGlite database in
`data/pglite/`. Financial workflows use typed child RPC commands; Electron
main and preload expose scoped page commands and live subscriptions. The
financial routes consume those live views, and the Spending page shows the
selected month while its Pairing dialog pages globally ranked candidates.
The fresh PGlite baseline replaces the superseded historical transfer
command. Existing `canonical.sqlite` and `ledger.sqlite` files are neither
opened nor modified by this cutover.

Daily asset and liability history uses dates with observed balances only.
Asset observations include investment valuations observed on that date; gaps
are not filled with the preceding balance. Exchange-rate demand follows the
same observation dates.

Acceptance on the 2026-09-23 development machine covered the complete unit,
browser, Electron/CDP, build, and package-lock checks. The isolated 100,000
transaction / 10,001 invoice / 10,000 existing-link benchmark covered all
90,000 eligible candidates across 900 pages. Its cold/warm worker ranking
was 513/316 ms and confirmation was 31/26 ms. The compact live-page browser
benchmark recorded 586 ms to open Pairing and 116 ms to confirm. The
production Electron preload/IPC/worker benchmark on the same fixture recorded
591 ms to open and 107 ms to confirm, with 1/2 ms feedback and a 118 ms
maximum renderer long task. Navigation and refresh feedback measured 10/1 ms;
their full operations measured 969/1,721 ms. The shell appeared after
1,728 ms and the overview data was ready after 23,422 ms on this fixture.
These figures are local acceptance evidence for ADR 0028, not a cross-machine
guarantee.
