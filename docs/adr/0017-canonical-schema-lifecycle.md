# Canonical schema lifecycle

Status: accepted

The canonical SQLite database is opened, upgraded, validated, and handed to
writers through one lifecycle module. This decision moves physical-schema
ownership out of product writers and ad-hoc startup helpers while preserving
the existing canonical financial model and schema version (`20`). It is an
implementation boundary for [ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md),
not a change to financial meaning.

## Context

Before this decision, `canonical-source-store.ts` performed migration dispatch,
startup checks, and several additive `CREATE TABLE IF NOT EXISTS` repairs.
Historical migration bodies also owned their own transaction boundaries. That
made it possible for a migration to leave a partially upgraded database, for a
current-version database to be silently repaired by a writer, or for a writer
to use a raw `DatabaseSync` before the physical schema had been checked.

The application must continue to open existing v1–v20 ledgers, preserve
financial rows and source lineage, and support compatibility repairs already
required by the canonical schema. A failed upgrade must leave the original
database retryable and must never fall back to a second store.

## Decision

### 1. The lifecycle owns physical schema only

`CanonicalSchemaLifecycle` manages SQLite tables, indexes, views, triggers,
`user_version`, migration metadata, compatibility repair, and structural
validation. It does not decide financial admission, relation semantics,
projection contents, backup policy, or data retention.

The lifecycle's private physical implementation is kept in
`canonical-schema-implementation.ts`. It contains the v1–v20 schema
declarations, immutable migration bodies, schema repairs, migration backfills,
and non-mutating structural validators used to build and validate the
lifecycle plan. Projection table names in that module therefore describe
historical schema work or structural checks; they do not make it a live
projection writer. Live generation rebuild and synchronization remain owned by
the Projection Runtime under [ADR 0018](./0018-canonical-projection-runtime.md).

`canonical-database.ts` is the focused open composer. It first obtains the
lifecycle-validated database capability and then runs the post-open Contract
Purge data transition from `canonical-contract-purge.ts`. The purge module
owns its foreign-key closure deletion, durable purge audit, and projection
cutoff repair. This order keeps physical schema authority in the lifecycle and
keeps Contract Purge data mutation outside migrations and schema repairs.

Provider extension schema declarations that are needed by the lifecycle are
similarly isolated in provider schema modules such as
`fubon-credit-card-schema.ts`; provider writer modules retain compatibility
exports and financial admission behavior but do not create physical schema on
the validated production path.

Published source-contract purges therefore run only after `open` returns a
validated data capability. Their durable audit rows are the completion marker:
an absent audit is retried even when a previous process already committed the
schema version, so a crash between the schema and data transactions cannot
strand cleanup permanently. They execute in their own idempotent data
transaction and cannot be smuggled through a migration or repair callback. Their audit rows
remain the evidence that a purged source-capture commit once existed; guarded
projection-provenance rows and their triggers are not dropped and rebuilt.
Writable retry and read-only fail-closed validation consume one shared list of
required purge descriptors (including the v19 source-occurrence-content-v3
audit), and the public source-store validator consumes that same source, so
the three validation paths cannot silently disagree about completion.

### 2. `open` is the sole production schema entry point

Production code opens a canonical path through
`CanonicalSchemaLifecycle.open(databasePath, plan, options)`. The source-store
adapter delegates to that seam. The lifecycle chooses read-only versus
writable behavior, rejects unsupported versions, and returns only after the
store is validated.

### 3. A migration registry is the only production schema-change registry

Each published migration has an immutable id and an explicit version
transition. A registry is created for one immutable target version and must
contain exactly one adjacent `n→n+1` transition for every version from zero to
that target. The fresh physical v7 bootstrap is recorded through the adjacent
v1…v7 registry boundaries inside the single outer transaction; there is no
public `0→7` jump. Duplicate `fromVersion` transitions, gaps, jumps, transitions
beyond the target, extra transitions, and a lifecycle/registry target mismatch
are rejected. A private runtime brand means a
structurally similar object is rejected before it can receive a database. The
public registry surface contains immutable, non-executable transition metadata
only; executable callbacks live in a module-private `WeakMap` and there is no
public `run(db, ...)` bypass. Product
writers may require a capability, but they cannot be a second schema-change
entry point. The registry, current-version compatibility transitions, and every
repair descriptor are copied and frozen when a path is opened; mutating a plan
retained by a caller cannot change a live connection's schema authority.

### 4. Migrations and final validation share one outer transaction

For a writable upgrade, the lifecycle acquires `BEGIN IMMEDIATE`, runs every
pending migration, any declared current-version compatibility transition, and
schema-only repair, performs final structural validation, and commits once. A
failure rolls back schema, migration metadata, and `user_version` together.
Runtime configuration is verified before this commit while the outer
transaction is still rollback-capable; a runtime verification failure therefore
cannot leave a committed schema upgrade.
Copy-required compatibility transitions run through the migration capability,
even when the published `user_version` is already current; they are not
repairs and cannot be requested by a provider writer. Read-only opens never
mutate a database.
The lifecycle adapts legacy `DatabaseSync.exec` and `prepare` calls, including
multi-statement calls, so transaction-control statements cannot release or
commit that outer transaction. A prepared `COMMIT`, `END`, `ROLLBACK`,
`SAVEPOINT`, or `RELEASE` is rejected rather than passed through.
Each historical and current-version callback receives its own synchronous,
generation-scoped database facade. The facade, prepared statements, and close
operation are revoked as soon as the callback returns, including work queued
with a timer after the authorizer and transaction boundary are gone.
Callbacks must return synchronously; returning a promise or any thenable aborts
and rolls back the lifecycle. The facades expose an explicit method allowlist,
not reflective forwarding. Unknown helpers such as a tag-store factory are
rejected, so no return value can contain or leak the native connection.
Current-version transitions receive an even narrower physical-schema
capability: every data-producing CTAS form (including `AS SELECT`, `AS VALUES`,
and `AS WITH ... SELECT`) is rejected after tokenizing quoted and
schema-qualified table targets; CTEs, arbitrary DML, trigger creation, and any unlisted
object are rejected before execution. A legacy table rebuild may use an
immutable, source-owned `INSERT ... SELECT` target explicitly declared by its
transition; that exception is limited to the known widening staging tables,
requires an existing-table source, and is checked by the authorizer and the
post-transition snapshot. It is not a general current-version data-write
capability.
Current-version preflight and every final validation callback execute inside
the lifecycle transaction through the same strictly read-only restricted
capability. Read-only opens use that capability as well. They cannot issue
DDL, DML, transaction control, mutable pragmas, or replace the authorizer.

### 5. Legacy transaction statements become savepoints

The first implementation keeps the existing migration SQL and version
semantics intact while adapting their historical `BEGIN`/`COMMIT`/`ROLLBACK`
calls to savepoints inside the lifecycle transaction. This preserves a small
vertical change and makes old migration bodies unable to commit the outer
transaction. Future migrations should receive the lifecycle-owned transaction
directly.

### 6. Unknown or inconsistent state fails closed

An unsupported newer `user_version`, missing migration metadata, malformed
version chain, missing required object, or failed structural check prevents a
handle from being returned. A current-version database is not generally
treated as permission to recreate missing objects; only an explicitly declared
compatibility repair may run.
The migration ledger must be an exact contiguous published chain through the
current version. A legacy database may use the known v1 baseline; a fresh
database records the formerly v7-shaped bootstrap through adjacent version
entries in the same atomic open. Missing interior rows, unknown newer rows, and a
`user_version`/ledger mismatch all fail closed. A failed open releases its
owner and leaves the original database available for retry.

### 7. Published migrations are immutable

An already-published migration id, version, and SQL meaning are not edited to
repair a later defect. New compatibility behavior has a new fixed repair id
and version. This retains an auditable explanation of how an existing ledger
reached its physical state.

### 8. Repairs are versioned, bounded, and idempotent

Every repair declares its id, target schema version, precondition, allowlisted
operation, and post-validation. Repairs are allowed only for known compatible
states, are safe to retry, and must preserve row counts and source lineage.
They cannot purge, recollect, rewrite, or reinterpret financial data. Repairs
are schema-only: the runtime denies `INSERT`, `UPDATE`, and `DELETE`, including
against a newly-created allowlisted table. Copy-required financial/time/schema
widening is represented by an immutable current-version migration transition,
not by a repair; additive provider extensions remain named repairs.
At runtime a repair receives a fixed id, target version, precondition, and
schema-object allowlist. A temporary SQLite authorizer denies transaction
control, attachment, unsafe pragmas, all DML, and all unlisted schema
operations. A before/after schema snapshot and per-table row digest
additionally reject changes to pre-existing financial rows, columns, or
lineage—even if a malicious callback lists a financial table in its allowlist.
Direct `sqlite_sequence` DML is also denied. SQLite's internal AUTOINCREMENT
bookkeeping is allowed only while the guarded facade is executing an already
classified schema statement; callbacks cannot use that exception for their
own `INSERT`, `UPDATE`, or `DELETE`.
The table definition of every pre-existing table is immutable to a repair, so
an allowlist cannot authorize `ALTER TABLE financial_accounts` or an equivalent
rebuild.
The sole additive-column exception is a versioned repair whose id is in the
`canonical/attestation/` namespace and which names one non-financial
`*_attestation_events` provider table plus the exact columns it may add. The
authorizer and post-repair snapshot both enforce that list and preserve all old
columns and rows. It cannot be applied to a financial or generic existing table.
Only explicitly named rebuild staging relations may disappear. Current-version
compatibility transitions use the same financial snapshot and a stricter
physical-schema guard; CTAS and CTE-hidden row copies are rejected, and any
new non-staging user table must remain empty.
Trigger creation is additionally checked against the target table and parsed
body: a trigger must be named in the allowlist, target a newly created
allowlisted table, and write only to newly created allowlisted tables. CTE
wrapped or otherwise unparsed trigger DML fails closed. The only existing-target
exception is an explicitly declared provider-extension guard refresh; core
canonical/financial relations are always denied, and trigger bodies may not
write them.
Preconditions are evaluated through a read-only capability before that
snapshot, so a malformed precondition cannot modify the database while deciding
whether a repair applies.
Historical migrations may perform their published additive/widening schema
work, but each step snapshots the original columns and row digest of canonical
financial fact tables. Dropping and recreating one of those tables is accepted
only when every original column and row remains identical; row loss aborts the
outer transaction.

### 9. A validated handle is the writer capability

Successful lifecycle open creates an opaque `ValidatedCanonicalStore`. Its
constructor token and factory are module-private, and its database capability
is a frozen facade created only by the lifecycle. The native connection stays
private; the facade exposes only the data operations needed by canonical
writers and cannot be manufactured around an arbitrary raw `DatabaseSync`.
Production credit-card/provider schema guards validate lifecycle-owned stores
instead of creating physical objects; isolated tests may still use explicitly
named raw adapters. The source-store wrapper has its own private runtime brand
in addition to the validated database capability:
  `validateCanonicalSourceStore`, source reads, and source commits reject a
  structurally similar `{ db, ... }` object even if it reuses a real lifecycle
  database. The shared financial, loan, and investment writers likewise check
  the lifecycle database capability before doing any SQL; a product facade
  may forward that capability, but a raw or forged `DatabaseSync` cannot enter
  a production read/write seam.
The validated connection is permanently guarded: callers can perform the
ordinary data reads/writes and transaction boundaries needed by canonical
writers, but cannot call the authorizer/extension controls, mutate schema,
attach a database, or change schema-affecting pragmas. Named extension repairs
temporarily establish their own guarded savepoint and restore the permanent
guard before returning.
For a published domain data transition that must delete a complete foreign-key
closure, the non-forgeable store supplies one synchronous data-transaction
boundary. It privately enables deferred foreign-key checking, denies callback
transaction control and all schema changes, checks foreign keys before commit,
and rolls back on failure. The callback receives a generation-scoped facade;
it and every prepared statement obtained from it are revoked before commit or
rollback, so deferred callbacks cannot write or close the store later.
Ordinary database capabilities never receive that pragma authority.

### 10. Schema transitions are exclusive; validated runtime handles share a bounded path lease

Writable schema transitions use the SQLite busy timeout and `BEGIN IMMEDIATE`
to serialize migration and repair work on a database path. Lock contention is
reported rather than resolved by opening an alternate file. Once the schema is
validated, each returned handle retains a shared cross-process lease keyed by
the resolved database path in a sidecar SQLite database. Multiple current
runtime handles may therefore open the same path, while a later migration or
physical repair must acquire an exclusive lease and is blocked by every live
shared handle. The sidecar stays in rollback-journal mode so its shared read
transactions prevent `BEGIN EXCLUSIVE` transitions. A lease upgrade failure
restores the prior shared lease; if restoration is impossible, the affected
validated handle is revoked rather than continuing without schema ownership.

The lease uses an independent SQLite connection with a bounded busy timeout.
`close` is idempotent and releases the sidecar transaction and in-process
lease state; every open or transition failure releases them as well. SQLite
releases the sidecar lock when a process crashes, so the sidecar is not an
immortal PID lockfile and a later opener can recover without guessing process
liveness. The main database still uses its own bounded SQLite lock for
migration and data-write serialization.

### 11. Retry reopens the original database

A failed migration closes without committing and can be retried from the
original version. The lifecycle never creates a fallback database, silently
resets the ledger, or changes the path. External operational code remains
responsible for backup and restore before an upgrade.

### 12. Validation is structural and rebuild-aware

Final validation checks required tables, columns, indexes, views, triggers,
constraints, SQLite integrity, foreign keys, migration metadata, and projection
boundaries. It verifies that a known rebuild can preserve its rows, but it does
not scan and reinterpret every financial record as part of opening. Financial
admission remains the responsibility of canonical writers.

### 13. Runtime schema creation is either lifecycle-owned or a capability check

Provider extensions and canonical physical tables are installed by a declared
lifecycle migration/repair and checked by non-mutating validators after open.
Writers may request only an explicitly allowlisted, named extension capability
through that registry; a validated production database cannot cause an ad-hoc
`CREATE TABLE`, `ALTER TABLE`, or trigger replacement. Operational or
noncanonical stores are outside this physical schema boundary and must remain
explicitly identified.
Canonical human-attestation event tables use named lifecycle repair
capabilities (one provider/table contract per registry entry); their event-row
inserts remain ordinary writer DML. Legacy provider attestation tables may use
the narrow additive-column exception described above; all other pre-existing
table definitions remain immutable to repairs. The old `CREATE TABLE IF NOT EXISTS`
fallback is retained only for isolated raw adapters, not for a validated
production store. Credit-card and provider extensions follow the same named
repair path.

### 14. This phase preserves v20 and financial semantics

The first seam cutover does not add a schema version, alter canonical money,
identity, time, relation, or projection semantics, or make the schema lifecycle
perform purge/recollection or reset. Existing published source-contract cleanup
behavior remains a separate validated data transition after schema open; it is
not newly broadened or reinterpreted here. The cutover only changes who owns
physical schema lifecycle and makes existing compatibility behavior atomic and
observable. A future semantic change requires its own migration and domain
decision.

## Consequences

- A writer can begin canonical work only after it receives a lifecycle-validated
  database capability.
- Migration failures leave the original version, schema objects, and metadata
  intact, so the same path can be diagnosed and retried.
- Existing migration bodies remain temporarily in the source-store module, but
  the lifecycle is their only production orchestrator; they are not a second
  public seam.
- Compatibility transitions and schema-only repairs are explicit and testable.
  A novel or ambiguous current-version defect stops startup until a new
  lifecycle contract is designed; no provider callback can turn a repair into
  a data-seeding operation.
- Backups, recovery copies, and filesystem replacement remain operational
  responsibilities rather than hidden lifecycle side effects.

## Rejected alternatives

- Letting each provider writer create its own tables: this recreates the
  startup race and makes schema ownership impossible to audit.
- Running every historical migration as an independent transaction: a later
  failure can leave earlier schema changes committed.
- Automatically repairing every missing current-version object: a missing
  object may indicate corruption or an unrecognized database, not a safe
  compatibility case.
- Returning a raw `DatabaseSync` from production open: callers could bypass
  validation and physical-schema ownership.
- Creating a fallback or reset database after failure: it hides data-loss risk
  and prevents a reliable retry from the original state.
- Rewriting published migration versions or SQL: it erases upgrade history.
- Full financial row reinterpretation during schema open: it couples physical
  lifecycle to domain admission and makes startup unbounded.
