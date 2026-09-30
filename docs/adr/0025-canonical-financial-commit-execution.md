# Canonical Financial Commit execution

Status: accepted

All provider Source Capture paths use one application-facing execution module
for canonical persistence orchestration. The module owns the validated
database handle, per-execution-item transaction, writer serialization, generic
admission checks, post-commit relation follow-through, cancellation, and
operational result aggregation. It does not change the canonical schema,
financial meaning, projection meaning, or the domain-specific evidence rules
that determine whether a provider Capture can be assembled.

## Context

The canonical schema lifecycle already owns physical schema authority and
returns a validated data capability under [ADR 0017](./0017-canonical-schema-lifecycle.md).
Shared financial admission already defines the atomic [Canonical Financial
Commit](../specs/canonical-financial-storage.md), while loan and investment
adapters retain their domain-specific rules under [ADR 0020](./0020-shared-financial-admission-and-relation-follow-through.md).
Relation resolution is asynchronous to a workflow run and has its own
append-only commit under [ADR 0016](./0016-evidence-gated-loan-repayment-relations.md).

In practice, provider workflows still know too much about canonical
persistence. They select and fall back between source and financial ledger
paths, create stores and writer keys, manage handle lifetime, choose commit
ordering, and invoke relation follow-through from individual workflows. This
duplicates the persistence sequence across bank, credit-card, loan,
investment, and electronic-invoice paths. It also permits a path value for
one store kind to reach a constructor for another, as demonstrated by the
Fubon loan `EEXIST` failure when a database path was treated as a ledger
directory.

The application has no product users or persisted settings that require
compatibility for the old source/financial ledger aliases. The execution seam
can therefore be tightened in one migration while preserving the existing
canonical behavior.

## Decision

### 1. One execution module is the provider persistence seam

Create `src/ledger/canonical/canonical-financial-commit-execution.ts` as the
application-facing execution module for provider Source Capture paths. It is
an implementation orchestration module for the existing Canonical Financial
Commit, not a new domain concept. Provider adapters cross this seam and do not
open canonical stores, construct writer keys, access raw database handles, or
call canonical `close()` themselves.

The module covers all provider Source Capture paths for banks, credit cards,
loans, investments, and electronic invoices. User-governed writes, Contract
Purge, and projection rebuilds remain outside this module because they have
different transaction and ownership semantics.

### 2. A single canonical ledger is the production topology

Production configuration uses one `canonicalLedgerDir`. The old
`canonicalSourceLedgerDir` and `canonicalFinancialLedgerDir` aliases are
removed from production workflows and are not retained as workflow-level
fallbacks. No settings migration is needed because there are no users or
persisted settings in scope.

The execution module opens the one lifecycle-validated canonical handle
through the existing lifecycle/database seam. A provider run owns one handle
for its lifetime, and the module closes it on every success, failure, and
cancellation path. Callers receive neither the handle nor a lifetime
obligation.

### 3. Each complete execution item preserves grouped atomicity

The provider adapter remains responsible for its source contract,
pagination, completeness, identity evidence, and domain-specific Capture
construction. Before starting a transaction, the execution module rechecks
the generic Canonical admission invariants; it does not trust an arbitrary
caller to have performed those checks.

The controlled run submits independent execution items one at a time. An
execution item is one complete provider-domain capture, not a new domain
concept. Depending on the provider contract, one item may atomically admit one
or more related Source Captures that form the same evidence spine, such as a
loan counterpart spine or an investment margin spine. All Source Captures
admitted by one item share one Canonical Financial Commit and either become
fully visible together or leave no financial effect. An item that admits zero
Source Captures is invalid and is an item failure. A validation or admission
failure for one item does not prevent independent items from being processed;
incomplete or partial source data never becomes a partial canonical Capture.

Only the active commit is serialized. Writer queues and writer keys remain
inside the execution implementation, so concurrent provider runs do not hold
a lock across browser or network work. A run may share its validated handle
across execution items, but it never shares a transaction across independent
items. Related Source Captures within one item intentionally share that
item's transaction.

### 4. Relation follow-through occurs after the source commit

After an execution item commits successfully, the execution module follows the
existing sequencing policy and invokes any applicable domain-specific relation
resolver. Relation evidence, request shape, and resolution judgment remain
owned by their domain modules. A resolver failure does not roll back or hide
the item's Source Captures; it produces an operational warning. A newly
persisted resolution judgment continues to receive its own Canonical Financial
Commit as required by ADR 0016.

The execution module does not add a background retry scheduler or automatic
commit retry. A later relevant Capture or explicit rerun uses the existing
Capture identity and admission idempotency. If a database error occurs after
transaction execution may have begun, the module does not guess whether a
commit became visible.

### 5. Run results are structured and fail closed

The run reports one of four aggregate statuses: `completed`,
`partially-completed`, `failed`, or `cancelled`. A run is `completed` when all
submitted independent execution items commit successfully. It is
`partially-completed` when at least one item commits and at least one item
failure is recorded. A run with no successful item or with a run-fatal
failure is `failed`. Cancellation is `cancelled`, while already committed
items and their Source Captures remain part of the result.

Source incompleteness, a validation failure within one item, and a single
admission failure are item failures. Schema validation, database open,
writer-queue, disk or other I/O, transaction-state, and capability violations
are run-fatal. A run-fatal failure stops new execution items, completes or
rolls back the active transaction as required by SQLite, closes the handle,
and returns the failure. Cancellation stops acceptance of new execution items;
the active transaction must complete or roll back before the handle is closed.

Operational diagnostics are structured, remain outside canonical storage, and
are not financial evidence. They contain only provider, product, a
non-sensitive item key, execution stage, stable error code, and a sanitized
message. They never expose account identifiers, source payloads, SQL, local
paths, or credentials to the UI diagnostic seam.

### 6. The architecture rule is executable

Add a repository architecture check that rejects production provider imports
of canonical store constructors, writer keys, raw database handles, or
canonical lifetime management. The allowlist is limited to the canonical
execution/lifecycle implementation and explicitly scoped migration, repair,
and contract tests. General provider production code and ordinary workflow
tests must cross the execution seam.

## Consequences

- Provider adapters become responsible for source observation and evidence,
  while canonical persistence ordering and lifetime have one locality.
- A provider run can report useful partial completion without leaving partial
  financial facts in canonical storage.
- Concurrent providers can perform source work independently; only their
  individual canonical commits contend for writer serialization.
- Existing relation behavior remains append-only and retryable from retained
  history, while its warning state is explicit in operational results.
- Tests for provider workflows substitute the execution seam and inspect
  Capture/evidence delivery and result handling. Canonical execution contract
  tests use temporary SQLite databases to verify grouped per-item transaction
  atomicity, rollback, serialization, relation ordering, cancellation,
  diagnostics, and close behavior.
- Removing the old aliases may require updates to development fixtures and
  test setup, but it does not require a persisted-configuration migration.
- Schema version, migration fingerprints, source lineage, Canonical Financial
  Commit semantics, and projection semantics remain unchanged.

## Rejected alternatives

- Letting each provider workflow create and close its own canonical store:
  this recreates the shallow persistence seam and allows path, writer, and
  lifetime knowledge to spread again.
- Keeping separate source and financial canonical ledgers: two SQLite
  databases cannot provide one indivisible Canonical Financial Commit or
  foreign-key boundary.
- Treating an entire provider run as one transaction: one incomplete or failed
  account would unnecessarily roll back independent complete execution items
  and would hold the writer across source work.
- Treating every Source Capture as an independent transaction: this would
  break the existing grouped atomicity required when one provider-domain
  capture contains related Source Captures, such as loan counterpart or
  investment margin spines.
- Serializing an entire provider run: browser and network latency would block
  unrelated provider commits without increasing financial correctness.
- Retrying every failed transaction automatically: after execution begins,
  the module cannot safely infer whether SQLite made the commit visible.
- Rolling back committed Captures after a later relation or item failure:
  relation follow-through is a separate append-only judgment, and a failed
  item must not erase an already accepted financial fact.
- Exposing a generic relation interface through this module: relation
  evidence and resolution semantics are domain-specific; only the
  post-commit sequencing policy is shared.
- Returning raw database handles or a public testing adapter: callers could
  bypass lifecycle validation and recreate the physical-schema seam.

## Behavior freeze

This decision is an architectural cutover only. It does not add a schema
version, rewrite a published migration, change migration fingerprints, alter
money, identity, effective-time, completeness, relation, admission, or
projection semantics, or broaden Contract Purge. Existing ledger fixtures,
migration and repair behavior, read-only open, rollback, provider admission,
relation follow-through, projection, spending, and purge behavior remain the
acceptance baseline. Any financial or migration meaning change requires a
separate decision and migration.

The execution-item clarification above corrects the earlier per-Capture
wording using grouped atomicity already present in the implementation and its
contract surface. It is a behavior-freeze correction discovered from that
existing implementation, not a new domain term or a change to Canonical
Financial Commit meaning.
