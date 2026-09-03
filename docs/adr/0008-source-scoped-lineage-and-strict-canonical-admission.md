# Source-scoped lineage and strict canonical admission

Status: accepted

OctopusBeak admits canonical financial data only through total, versioned integration contracts; keeps identity source-scoped and immutable; and preserves append-only Source, Derived, and User Assertion lineage without conflict states or manual financial correction. This sacrifices cross-source reconciliation, permissive ingestion, raw replay, and repair-in-place so current and historical projections never depend on guessed identity, time, status, or precedence.

This ADR supersedes [ADR 0005](./0005-conservative-transaction-identity-and-revision-semantics.md) and amends the identity, evidence-retention, admission, `unknown`, candidate, effective-time, and user-correction portions of [ADR 0004](./0004-plaid-inspired-canonical-financial-model.md) and [ADR 0007](./0007-canonical-transaction-status-and-relation-semantics.md).

## Decision

### Collection and processing are separate lineage

A Source Capture exists only after one independent source-side observation passes its integration contract and sync admission checks. It records integration and contract version, Source Connection, product and account scope, observation time, completeness, and zero or more compact Source Records. A retry, pagination step, or processing rerun is not a new Capture; a later independent live observation is, even if its compact values are identical.

Each Source Record belongs to exactly one Capture and is an immutable, compact evidence projection containing only identifiers, financial values, and provenance needed for canonical mapping. The first version stores no replayable PDF, CSV, response, page, or Source Artifact. It can rerun rules over retained compact fields but cannot recover an extraction field that was discarded.

An Import Run atomically processes retained Source Records under identified parser and rule versions. Initial required mapping failure cancels the attempted Capture. A failed or partial rerun of an accepted Capture changes nothing; a successful complete-scope rerun may change only Derived Assertion lineage.

### Identity is source-scoped and has no correction workflow

Financial Account and Financial Transaction identity is established from integration namespace, Source Connection, product stream where applicable, a contract-defined stable source key, and an Identity Epoch. Accounts or transactions from different integrations or connections never share canonical identity, even when they appear to represent the same real-world subject or event.

An Identity Epoch is a fence around one key uniqueness scope, normalization, reuse policy, and subject meaning. A new connection or a change to any of those identity semantics starts a new epoch that is never reconciled with the old one; non-identity parser and enrichment changes advance only their contract or rule version.

The first version has no provisional or conflicted identity, cross-source merge, split, relink, user merge, fuzzy deduplication, or Identity Correction. Source Authority Routing assigns one authoritative integration, connection, and stream to each projection input. User-facing Account Display Groups may organize accounts visually but cannot change identity, move facts, deduplicate, or authorize aggregation.

If an admitted contract is later proven wrong, a source-scoped Contract Purge atomically hard-deletes all affected Captures and dependent Records, Assertions, revisions, relationships, and projections for the integration, connection, product stream, contract version, or identity epoch. Only non-financial operational audit metadata remains; the old version or epoch is disabled, and recovery requires recollection. Unavailable historical source data is intentionally lost rather than repaired through identity lineage.

### Assertions have origin-specific lifecycle

Every accepted claim belongs to one origin stream:

- Source Assertion: a fact explicitly supported by compact Source Records;
- Derived Assertion: a versioned parser, normalization, enrichment, or reconciliation result; or
- User Assertion: a person's explicit value for a user-governed field.

Only a continuous same-origin, same-producer claim lineage may supersede itself. Cross-origin overwrite is forbidden. Current projections apply contract-declared Source Authority Routing and producer authority rather than last-write-wins or runtime conflict selection.

Source Assertions may be revised only through contract-established stable claim identity. An explicit tombstone or absence from a comparable contract-declared complete scope may withdraw a Source Assertion; later reassertion of the same stable key may restore it. Withdrawal and restoration describe source support, not refund, reversal, cancellation, deletion, or Contract Purge, and users cannot initiate them.

A successful, atomic, complete-scope Import Run handles one Derived lineage in three ways: a changed supported value supersedes the old assertion; an explicitly unsupported optional fact withdraws it; and an unchanged value retains its assertion while gaining run provenance. Failed or partial output has no effect, and one producer never supersedes another producer's lineage. Enrichment may provide descriptive and organizational facts but cannot rewrite financial amounts, dates, status, balances, holdings, or Statement totals.

User Assertions are limited in the first version to display names, categories, tags, and notes. They may take projection precedence for those fields and may be withdrawn so projection falls back to the next valid assertion. Users cannot override financial facts, choose a Statement candidate, establish identity, or withdraw and restore Source Assertions.

### Admission is total and conflict-free

Every required canonical classification and identity must have one contract-defined value before persistence. Required enums never use `unknown`; unsupported optional facts are absent. Transaction posting status is exactly `pending | posted`. An indeterminate, unsupported, or mutually incompatible required candidate is an integration contract or sync preflight error that cancels the entire attempted Capture; canonical storage contains no conflict status, candidate assertions, partial Capture, or financial conflict selector.

A new billing cycle creates a new Statement. A Statement Revision exists only when stable source identity, revision, or replacement semantics prove that the source corrected the same Statement. Ambiguous same-period documents are rejected by the integration rather than stored for canonical or user selection.

A new Balance or Holding measurement creates a new Observation. An Observation Revision exists only when the integration contract proves that the source corrected the same measurement; matching dates, recollection, and rerunning a Capture are insufficient. Repeated independent observations are retained even when values match, while repeated claims may share canonical claim lineage and add Capture provenance.

### Time requirements follow fact type

All admitted lineage records mandatory `recorded_at`. Fact types declare financial effective time as required or not applicable rather than exposing a universal nullable field:

- Transactions require their contract-defined effective date and precision.
- Statements require their settled cycle and applicable dates.
- Balance and Holding Observations require contract-defined `effective_at` so they can support historical valuation.
- Account lifecycle facts require contract-defined `effective_at` because they affect synchronization and historical financial scope.
- Pure names, labels, categories, tags, and notes have no financial effective time and use `recorded_at` only.

One narrow exception applies to an instantaneous/current-state balance API whose response semantics have been verified: the provider-origin HTTP `Date` may establish that response snapshot's financial effective time. The integration must retain the source-reported evidence type, provenance, and value; an absent or invalid provider `Date` fails closed. This exception does not apply to historical statements, delayed-settlement data, or endpoints without verified current-state semantics. Local collection, file, import, and recording times never substitute for required effective time. Backfilled source data keeps its historical financial effective time and the current admission time, so financial-time and knowledge-time queries do not pretend the system knew the fact earlier.

## Consequences

- Integrations must provide fixtures for every accepted record kind, required classification, identity key, completeness rule, temporal requirement, revision link, and authority route. Runtime surprises fail the whole Capture.
- Current projections are simpler because they never interpret `unknown`, identity conflict, match candidates, user financial overrides, or partial imports.
- Cross-source duplicates and identity discontinuities remain visible by design. Presentation grouping does not make them safe to aggregate.
- Historical reproducibility covers compact admitted evidence, assertion lineage, financial effective time, and system recording time; it does not cover discarded raw inputs or purged contract data.
- Plaid remains a comparison model only. OctopusBeak is intentionally stricter than Plaid's nullable balance and holding time metadata because historical valuation requires effective time; the comparison is recorded in [Plaid reference semantics for missing or imprecise effective time](../research/plaid-effective-time-semantics.md).

## Rejected alternatives

- Preserve raw Source Artifacts for parser replay: the first version stores only compact integration output.
- Store `unknown`, conflicts, or candidates for later resolution: unresolved required semantics fail admission.
- Repair identity through merge, split, relink, or user action: identity stays source-scoped; contract bugs purge and recollect.
- Reconcile cross-source duplicates: authority routing prevents duplicate use without shared identity.
- Allow users to correct financial facts: the first version limits user assertions to descriptive and organizational fields.
