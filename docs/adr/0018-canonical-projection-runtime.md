# Canonical Projection Runtime

Status: accepted

The `Canonical Projection Runtime` is the sole runtime authority for building,
selecting, and reading canonical financial projections. This decision deepens
the projection module without changing the financial meaning established by
[ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md) or the
physical-schema ownership established by
[ADR 0017](./0017-canonical-schema-lifecycle.md). The schema remains version
20.

## Context

Projection generation selection, compatibility synchronization, loan
selection, relation selection, and investment current-state derivation were
spread across writers and query modules. Callers needed to know physical table
names and active-generation rules. That shallow seam made a projection change
hard to test through one interface and allowed two callers to observe different
Knowledge Points during one logical read.

Current and Historical Financial Projections also have different authority.
Current reads use the active materialized generation. Historical reads are
query-time reconstructions from immutable facts and assertion lifecycle at
explicit financial-time and knowledge-time cutoffs; a retired generation is
not historical financial authority.

## Decision

### 1. One runtime projection authority

The Runtime owns incremental projection updates, shadow rebuilds, projection
provenance, active-generation switching, Knowledge Point selection, and eager
projection snapshot reads. Financial, loan, investment, and relation callers
must not select a generation or write generation rows directly.

The public Runtime factory remains in
`canonical-projection-runtime.ts`; the live rebuild and compatibility
synchronization implementations are private to
`canonical-projection-implementation.ts`. `canonical-source-store.ts` keeps
its published compatibility exports and source query adapters, including the
historical field assembly used by those adapters, but it no longer contains
the live rebuild or synchronization implementation and it owns its generic
writer queue locally. The Runtime implementation has no dependency on the
source-store composition module.

The lifecycle implementation may still mention projection relations for
historical migrations, migration backfills, and non-mutating structural
validation. Those operations preserve the published v1–v20 physical schema
and are governed by [ADR 0017](./0017-canonical-schema-lifecycle.md); they are
not a second live projection authority. The post-open Contract Purge remains
the owner of its data transition and cutoff repair, composed with lifecycle
open by `canonical-database.ts`.

The Runtime has three conceptual entry points: apply one Canonical Financial
Commit, read one projection snapshot, and rebuild the materialized projection.
Their TypeScript shapes may evolve without revisiting this decision.

### 2. Transaction ownership follows the operation

An incremental apply participates in the caller-owned Canonical Financial
Commit transaction. It cannot commit, roll back, open a second connection, or
enter another writer queue. This keeps immutable facts and their Current
Financial Projection atomic.

A full rebuild owns its writer-queue turn and transaction. It builds and
validates a shadow generation before performing one active-generation switch.
A failed rebuild leaves the previous active generation readable.

Physical schema, migrations, and compatibility repairs remain owned by the
Canonical Schema Lifecycle. Historical migration bodies do not become part of
the Runtime's public interface.

### 3. Closed impact policy

The Runtime derives projection impact from retained commit lineage. Its impact
registry is closed and versioned inside the module. Every known commit kind
either has an impact collector or is explicitly a no-op. An unknown kind fails
closed and rolls back the outer commit. Reapplying a retained commit is
idempotent and does not duplicate projection provenance.

Provider workflows do not submit affected identifiers and cannot register
runtime impact behavior.

### 4. Eager, bounded, all-or-nothing reads

A read requests one or more members of a closed, versioned projection-family
set and supplies an explicit bounded scope. The Runtime fixes one SQLite
snapshot, one Canonical Knowledge Point, and—when current—one active generation;
it fully reads every requested family before closing the transaction and
returns immutable data.

There is no implicit whole-ledger read, lazy database handle, SQL callback, or
runtime family registration. If any requested family cannot be produced, the
entire multi-family read fails without returning partial financial rows.

Historical reads require both financial-time and knowledge-time cutoffs and
reconstruct from immutable facts and assertion lifecycle. They never read a
retired generation.

### 5. Investment stays query-time derived in v20

Investment families are derived by the Runtime from immutable investment facts
inside the same read snapshot and Knowledge Point as other requested families.
They do not introduce materialized investment generation tables or a version
21 schema. Materialization, if later justified by measured query cost, requires
a separate schema decision.

## Consequences

Projection behavior has one interface test surface and generation knowledge has
locality. Adding a commit kind or projection family requires an explicit,
reviewed Runtime change. Callers receive less flexibility and cannot use ad-hoc
SQL as a shortcut, but this prevents silent partial projection updates and
mixed-generation reads.

The canonical financial writer itself is not otherwise redesigned. Existing
provider capture formats and historical migration behavior remain unchanged.
