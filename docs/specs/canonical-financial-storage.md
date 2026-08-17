# Canonical financial storage specification

Status: implementation-ready planning specification

This specification resolves GitHub issue 124. It translates ADRs 0004–0010 and the root glossary into a first-version physical storage and query boundary. It specifies table responsibilities, mandatory constraints, transaction boundaries, and verification criteria; exact SQL names may change during implementation only when the same guarantees remain mechanically enforceable. The typed enrichment extensions to this storage boundary are defined by [Transaction taxonomy and enrichment specification](./transaction-taxonomy-and-enrichment.md) and ADR 0011.

## 1. Storage boundary

Use one canonical SQLite database for all admitted financial evidence and projections:

- canonical schema version and commit ordering;
- Source Connections, Collection Scope Versions, Identity Epochs, and committed Source Sync State;
- accepted Source Captures, typed Capture Scopes, and compact Source Records;
- source-scoped identities and immutable typed revisions;
- Source, Derived, and User Assertion lineage and provenance;
- successful complete-scope Import Runs;
- Source Authority Routing; and
- disposable Current Financial Projection generations.

Keep the following in operational configuration or operational audit storage, outside the canonical database:

- authentication secrets and sign-in details;
- integration settings, schedules, UI preferences, and Statement Selections;
- incomplete Sync Attempt Checkpoints and collection staging;
- failed collection and Import Run diagnostics;
- deletion scrub jobs and non-financial deletion audit; and
- Legacy Data Quarantine.

Operational configuration links to a canonical Source Connection through an opaque configuration reference. The canonical store retains a sanitized, versioned Collection Scope Version and fingerprint, never credentials. Because no cross-database transaction or foreign key exists, admission rechecks the scope version immediately before its canonical commit; a semantic change cancels and retries the attempt.

## 2. Physical conventions

### 2.1 Identifiers

- Application-generated UUIDv7 is the durable local identifier for canonical rows.
- Store UUIDs as 16-byte `BLOB`; convert to text only at API and log boundaries.
- UUID time bits do not define `recorded_at`, ordering, identity, or uniqueness.
- Every source-scoped identity has an explicit natural-key `UNIQUE` constraint including its integration namespace, Source Connection, Identity Epoch, product stream where applicable, and contract-defined stable source key.

### 2.2 Exact decimal values

Represent every monetary quantity, balance, holding quantity, price, and rate with typed columns:

- normalized decimal digits as text `coefficient`;
- integer `scale`;
- explicit sign or domain direction when negative values are meaningful; and
- denomination columns appropriate to the domain, such as ISO currency or Security ID.

Transaction amounts are non-negative and store direction separately. Do not use SQLite `REAL` or JavaScript `Number` for financial arithmetic. Use `BigInt` or an exact decimal implementation; SQL aggregation requires registered exact-decimal functions. Source formatting may remain only in a compact Source Record payload.

### 2.3 Time and knowledge

`canonical_commits` provides one knowledge point for every atomic canonical change:

- `commit_id BLOB(16)` primary key;
- strictly increasing local `commit_sequence INTEGER` unique and not null;
- `recorded_at_utc_us INTEGER` not null; and
- controlled `commit_kind` plus non-financial operation reference where needed.

Every row created by a commit references its `commit_id`. Knowledge-time comparison uses `commit_sequence`; wall-clock timestamps never break ties or backdate newly admitted facts.

Financial time is fact-specific. Typed revision tables preserve the source precision and meaning using the necessary combination of local date, local time, timezone or offset, precision enum, UTC instant in integer microseconds, and a UTC sorting anchor. A date-only value may use UTC midnight as an internal anchor but must never be presented as a source timestamp. Transactions, Statements, Balance and Holding Observations, and account lifecycle facts require their contract-defined effective time; descriptive user fields do not.

### 2.4 Immutability and foreign keys

- Enable `PRAGMA foreign_keys = ON` on every connection.
- Identity rows contain only identity invariants and are never updated in place.
- Financial and descriptive changes create immutable revisions or assertions.
- All domain references use real foreign keys. Do not use generic `(target_type, target_id)` references.
- Compact integration JSON is permitted only in `source_records`; it cannot be a canonical value, identity, completeness, withdrawal, or projection authority.

Contract Purge, Canonical Reset, and separately specified user deletion are the only hard-deletion paths. Assertion withdrawal is not deletion.

## 3. Table families

### 3.1 Schema and commit tables

`schema_migrations`

- Records the monotonic canonical schema version and applied commit metadata.
- The application refuses to open its writer against an unsupported newer version.
- First-version migrations are forward-only.

`canonical_commits`

- Owns strict knowledge ordering for captures, import results, user assertions, routing changes, purges, and projection switches.
- One application-level writer allocates `commit_sequence` inside `BEGIN IMMEDIATE`.

### 3.2 Collection and evidence tables

`source_connections`

- Source-scoped namespace linked to an opaque operational configuration reference.
- Stores integration namespace and lifecycle metadata, not financial account lifecycle or secrets.

`collection_scope_versions`

- Immutable sanitized description and fingerprint of collection semantics admitted from operational configuration.
- Secret rotation, scheduling, and presentation-only settings do not require a new version.

`identity_epochs`

- Immutable fence for stable-key scope, normalization, reuse rules, and identified subject meaning.
- A change to those semantics starts a new epoch; epochs never reconcile.

`source_sync_states`

- Scoped to Source Connection, product stream, and optional Financial Account when the provider requires it.
- Stores only opaque provider continuation state and health metadata.
- Has a natural unique constraint on that scope.
- Advances only in the same commit as the complete accepted Capture it covers. Providers without continuation state leave it absent.

`source_captures`

- Immutable envelope for one independently observed, admitted collection event.
- References Source Connection, contract version, Collection Scope Version, Canonical Commit, and observation time.
- Contains no partial or failed attempt.

`capture_scopes`

- Typed rows describing subject reference, product stream, optional start/end financial range, and completeness enum such as complete snapshot, complete range, or incremental.
- References the contract rule that proves completeness.
- Empty results and absence of a next page do not establish completeness without that rule.

`source_records`

- Immutable occurrence within exactly one Capture.
- Stores contract-defined record kind, stable source record key when available, compact contract-versioned JSON payload, and content hash.
- Each independent Capture retains its own occurrence even when hashes match. The hash supports integrity and equality checks, not identity.

`source_record_scopes`

- Join table linking one Source Record to one or more scopes within its Capture.
- Composite foreign-key or trigger enforcement must prevent linking across Captures.

The first version stores compact payloads inline. It has no Source Artifact, replayable raw file, response, DOM, content-addressed blob table, or shared payload row.

### 3.3 Typed identity tables

Provide separate identity tables for at least:

- `financial_accounts`;
- `card_instruments`;
- `securities`;
- `financial_transactions`;
- `statements`; and
- `balance_observations` and `holding_observations`.

Each table contains its UUID, source-scoped natural identity, Identity Epoch, creation commit, and only true identity invariants. Optional account subtype, name, lifecycle, and other changing properties belong to revisions or assertions. Account top-level type is required and contract-defined; a later semantic contradiction is a contract/epoch error requiring purge or reset, not an in-place update.

A Card Instrument belongs to a Financial Account but never substitutes for it. Different primary or supplementary card masks do not create separate accounts unless the contract independently proves separate account identity.

### 3.4 Typed revision and relation tables

`account_revisions`

- Immutable typed account facts and lifecycle assertions supported at one financial effective time and knowledge point.

`transaction_revisions`

- Immutable transaction facts including required posting status `pending | posted`, non-negative exact amount, direction, denomination, effective date/time precision, description fields, and source revision identity.
- A revision is created only when the contract proves correction or continuation of the same source-scoped Transaction identity.

`statement_revisions`

- Immutable source-proven revision of the same Statement, with cycle, billing dates, due dates, and exact totals as supported by the contract.
- A new billing cycle creates a new Statement, not a revision.

`statement_memberships`

- Owned by one Statement Revision and pinned to a specific Transaction Revision.
- A later Transaction Revision cannot rewrite historical Statement membership.
- User selection cannot change canonical membership or financial totals.

`balance_observation_revisions` and `holding_observation_revisions`

- Store exact observed value, required contract-defined effective time, and knowledge point.
- Each independent measurement creates a new Observation even when its value matches. Only a contract-proven correction of the same measurement creates another revision under one Observation.
- Balance scope is Financial Account, balance kind, and denomination. Holding scope is Financial Account and Security.
- A transaction `balance_after` may support a clearly marked derived post-transaction Balance Observation only when the contract proves its ledger point and ordering. It never becomes provider current balance, and incomplete transaction history never synthesizes a balance.

`transaction_relations`

- Immutable typed edge between two Transactions with real foreign keys and no self relation.
- Directed relation kinds retain endpoint direction. Symmetric transfer relations use canonical endpoint ordering.
- Enforce uniqueness for relation type, endpoint pair, and source scope.
- Do not impose global one-to-one cardinality: multiple refunds, reversals, installments, and transfers may be valid.
- First-version relations remain within one contract-provable Source Connection and Identity Epoch. Cross-connection similarity does not create a relation.

### 3.5 Assertion spine and typed targets

`assertion_lineages`

- Defines one continuous origin, producer, rule lineage, subject, and governed field or typed fact scope.
- Origins are controlled values: Source, Derived, or User.

`assertions`

- Immutable claim metadata referencing lineage, producer/rule version, creation commit, and typed value or revision through an extension table.
- Direct source-backed coherent revisions may inherit revision-level lineage. Independently governed entity fields use field-level assertions.

`assertion_transitions`

- Append-only `observed`, `superseded`, `withdrawn`, or `restored` transitions with commit and cause.
- No mutable current-status column is authoritative.
- Supersession is allowed only within the same continuous producer lineage.

`assertion_provenance`

- Links Assertions to Source Records, successful Import Runs, supporting Assertions, or user action metadata using typed extension tables and real foreign keys.
- Reobserving an identical claim adds provenance instead of duplicating its typed revision or Assertion value.

Typed assertion target/value extensions

- Use separate tables for Transaction Revision, Observation Revision, Statement Revision, Transaction Relation, entity field, and registered user-governed value targets.
- Enforce exactly one target family per Assertion with constraints and admission tests.
- User-governed fields are registered and migration-controlled. Text, category, tag, and note values use typed representations; arbitrary field names or JSON values are forbidden.
- User Assertions cannot target financial amounts, currencies, directions, dates, posting status, balances, holdings, Statement totals, identity, or membership.
- Transaction Kind, Personal Category, Category Allocation, Counterparty Participation/display, and Transaction Tag use the typed registries, value tables, origin matrix, applicability rules, and current projection contract in the transaction taxonomy and enrichment specification; they do not use arbitrary field names or generic JSON values.

Canonical storage has no required-value `unknown`, conflict status, candidate set, manual financial selector, or Identity Correction. Missing, unsupported, or mutually incompatible required values cancel the attempted Capture before canonical commit.

### 3.6 Import Run tables

`import_runs`

- Stores only successful, committed runs over retained Source Records, with parser/rule versions and producer identity.

`import_run_output_scopes`

- Declares the complete subject, field, producer, and rule-lineage output scope.
- A run stages all output before commit. Its complete result atomically adds Derived Assertions, transitions, provenance, and affected current projection rows.
- A missing optional output may withdraw only when the declared complete output scope and rule semantics explicitly establish that result.

Failed or partial runs leave the previous complete result unchanged and write only operational diagnostics outside canonical storage. Initial required mapping failure cancels the attempted Capture; a later rerun failure cannot invalidate an already accepted Capture or its Source Assertions.

### 3.7 Authority and projection tables

`source_authority_routes`

- Immutable, versioned assignment of exactly one authoritative contract version, Source Connection, product stream, subject/fact/field scope, and producer at each knowledge point.
- Missing or overlapping active routes fail admission or projection rebuild.
- There is no numeric runtime priority, latest-source rule, fuzzy reconciliation, or user-selected financial authority.

`projection_generations`

- Tracks building, validated, active, and retired generations plus their projection rule version and build cutoff.

`active_projection_generation`

- Singleton pointer switched atomically after complete validation.

`current_*` projection tables

- Typed, query-oriented rows for current Financial Accounts, Transactions, Statements, balances, holdings, relations, and user-governed fields.
- Every selected value references its authority route and canonical revision or Assertion.
- Projection rows contain no independent financial authority and are fully rebuildable.
- Current transaction enrichment returns the selected typed Kind and categorization, all Counterparty Participations, display label with origin, active Tags, classification coverage, and report-eligibility coverage without creating another assertion or event system.

Do not materialize daily historical snapshots in the first version. Historical queries resolve immutable revisions, lifecycle transitions, and routes using both explicit financial-time and knowledge-time cutoffs.

## 4. Atomic operations

### 4.1 Accept Capture

Collect, paginate, and validate outside the canonical transaction. After complete staging:

1. recheck contract, Identity Epoch, Collection Scope Version, total required mappings, Capture Scope completeness, and authority coverage;
2. enter the single writer queue and `BEGIN IMMEDIATE`;
3. allocate one Canonical Financial Commit;
4. insert Capture, scopes, compact Records, identities/revisions, Source Assertions, transitions, and provenance;
5. advance the exact Source Sync State covered by the Capture;
6. update affected active current projection rows; and
7. commit all changes together.

Any failure rolls back the whole operation. A transport checkpoint never enters these tables.

### 4.2 Apply successful Import Run

Stage the complete declared output outside the transaction. In one canonical commit, insert the successful run and output scope, apply all Derived Assertion/provenance/lifecycle changes, and update the current projection. Failure changes none of them.

### 4.3 Apply User Assertion

Validate that the target is a registered user-governed field. In one canonical commit, append the User Assertion and any same-lineage supersession or withdrawal transition, then update the current projection. Clearing a field withdraws the user lineage so projection falls back; it does not delete source evidence.

### 4.4 Rebuild current projection

Routine canonical commits update the active generation incrementally. A projection schema, rule, authority, or precedence change uses a full rebuild:

1. pause the canonical writer queue while readers continue using the active generation;
2. build one shadow generation at a fixed Canonical Knowledge Point;
3. validate completeness, uniqueness, routes, references, exact arithmetic, and query invariants;
4. atomically switch `active_projection_generation`; and
5. resume queued writes.

The first version has no delta catch-up protocol. A failed build leaves the prior generation active.

### 4.5 Contract Purge

Before deletion, compute and validate the exact ownership closure for the disabled integration namespace, Source Connection, product stream, contract version, or Identity Epoch. The closure includes Captures, Records, owned identities, revisions, Assertions and transitions, relationships, sync state, and affected projections, and must not cross another connection/epoch or shared operational configuration.

One `BEGIN IMMEDIATE` transaction hard-deletes the validated closure, rebuilds affected active projections, and commits metadata sufficient to report the non-financial purge reason, counts, and fingerprint outside the financial lineage. Unexpected external references, constraint failures, or projection failures roll back the purge. Explicit owned children may use cascades; cross-ownership relations require explicit closure handling.

After financial deletion commits, a resumable operational scrub checkpoints/truncates WAL, enables secure deletion for subsequent work, vacuums when required, and records local scrub completion. Product guarantees application-level unreachability, not forensic erasure from APFS snapshots, Time Machine, external backups, or SSD internals.

## 5. Query boundary

Product modules may use only three typed query contracts:

1. **Current Projection Query** — reads one active generation and returns the presently authoritative domain view.
2. **Historical Projection Query** — requires explicit financial-time and Canonical Knowledge Point cutoffs, then resolves typed immutable facts and the authority route valid at that cutoff.
3. **Lineage Inspection Query** — returns the selected typed revision, assertion lineage and transitions, producer/rule metadata, supporting compact Source Records, and relevant commits without exposing secrets or raw replay.

Products must not:

- read compact JSON to calculate financial values;
- implement assertion precedence or Source Authority Routing;
- select latest observations or statement revisions themselves;
- combine legacy and canonical reads;
- query retired projection generations as fallback; or
- infer identity, withdrawal, effective time, or status from presentation data.

## 6. Index policy

Add indexes only for a declared query contract or integrity rule, and lock each important query shape with `EXPLAIN QUERY PLAN` regression tests.

Required index families are:

- natural-key unique indexes for every source-scoped identity and assertion lineage;
- foreign-key traversal indexes;
- active-generation and subject indexes for each `current_*` projection;
- financial-time indexes for Historical Projection scope and ordering;
- `commit_sequence` and lineage-transition indexes for knowledge-time resolution;
- bidirectional assertion provenance indexes;
- Capture, Capture Scope, Source Record, and completeness traversal indexes;
- Statement Revision membership indexes; and
- Transaction Relation endpoint and type indexes.

Do not add first-version indexes for compact JSON content, arbitrary description/note full text, approximate amount matching, UUID time bits, speculative Plaid access patterns, or redundant standalone `recorded_at` values.

## 7. SQLite runtime policy

- Use WAL mode, `synchronous = FULL`, foreign keys on every connection, and a bounded busy timeout.
- Route every canonical mutation through one application-owned writer queue.
- Start canonical commits with `BEGIN IMMEDIATE`.
- Use read-only snapshot connections for query contracts.
- On busy timeout, roll back and retry the whole operation; never continue a partially applied operation.
- Startup performs WAL recovery, schema-version compatibility, foreign-key integrity, and active-projection checks before opening the query boundary.

## 8. Schema evolution

- Apply monotonic semantics-preserving migrations transactionally before opening the writer or query boundary.
- Projection-only changes rebuild and switch a shadow generation without rewriting canonical history.
- A change requiring identity, effective-time, or evidence that retained data cannot prove must not backfill guesses. Purge and recollect the affected contract/epoch, or perform Canonical Reset when the incompatibility is global.
- Do not support downgrade in the first version. An older application must refuse to write a newer schema.

## 9. Acceptance checks

Implementation is acceptable only when automated tests prove:

1. required mapping, identity, effective-time, completeness, and route failures persist no partial Capture and do not advance Source Sync State;
2. one accepted Capture makes evidence, typed revisions, assertions, committed cursor, and current projection visible atomically;
3. equal compact payloads from independent Captures remain distinct occurrences without duplicating an unchanged assertion value;
4. failed or partial Import Runs leave canonical lineage and projections unchanged;
5. Current Projection selects only contract-routed, active assertions and is reproducible from the immutable write model;
6. Historical Projection changes correctly and independently across financial-time and knowledge-time cutoffs;
7. Statement membership remains pinned to Transaction Revisions after later revisions;
8. repeated Observations and contract-proven Observation corrections follow different identity paths;
9. exact decimal round trips and aggregates never lose precision;
10. no product query reads Source Record JSON, assertion tables, or legacy tables directly;
11. projection rebuild failure keeps the previous generation readable, while successful switching exposes no mixed generation;
12. Contract Purge either removes the complete validated ownership closure and its projection reachability or changes nothing;
13. an unsupported newer schema blocks the writer; and
14. declared query plans use the intended identity, current, historical, lineage, membership, and relation indexes.

## 10. Explicit first-version exclusions

This specification does not add raw artifact replay, Plaid connectivity, cross-source identity or deduplication, Identity Correction, conflict persistence, required-value `unknown`, manual financial correction, user Statement selection, parser/workflow semantics in the domain model, generic event sourcing, EAV, arbitrary JSON facts, approximate transaction matching, historical snapshot tables, or compatibility reads from the legacy ledger.
