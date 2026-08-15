# Conservative transaction identity and revision semantics

Status: accepted

## Context

OctopusBeak must reconcile overlapping bank and credit-card downloads whose rows usually have no provider transaction ID, pending linkage, tombstone, stable source sequence, or complete-snapshot guarantee. Content-based set deduplication can collapse two real transactions with the same date, amount, and description, while append-only import can count the same source occurrence repeatedly. In-place updates or deletes would also make historical financial computations impossible to reproduce.

This decision refines the Financial Transaction boundary in [ADR 0004](./0004-plaid-inspired-canonical-financial-model.md). Plaid's transaction IDs and `added` / `modified` / `removed` patch stream remain provider capabilities described in [the Plaid semantics research](../research/plaid-accounts-transactions-semantics.md); current Taiwan sources described in [the source-capability inventory](../research/octopusbeak-bank-source-capabilities.md) do not inherit those guarantees.

## Decision

OctopusBeak gives every Financial Transaction an opaque stable local ID and reconciles immutable source-record occurrences to that identity conservatively. False merges are more harmful than provisional duplicates: explicit source evidence or a deterministic versioned rule must establish equivalence, and weak or ambiguous similarity never silently merges transactions.

This ADR defines logical identity, matching, source-assertion lifecycle, revision, and correction semantics. It does not prescribe physical tables, indexes, importer sequencing, matching thresholds, or user-interface flows.

### Identity evidence

A content hash, normalized matching signature, capture row coordinate, or occurrence ordinal is evidence for matching, not a Financial Transaction identifier. Source records that share content remain separate immutable occurrences.

Identity continuity may be established by, in descending order of directness:

1. a provider transaction ID or stable source sequence with a documented scope and lifecycle;
2. another explicit source linkage that uniquely identifies the occurrence;
3. a validated source-specific deterministic rule, with its rule version and supporting records retained; or
4. an explicit user assertion.

Amount, nearby dates, description similarity, or a shared content hash alone creates at most a match candidate. When evidence is ambiguous, the candidate transactions remain separate. `financial_transaction_id` is never computed from mutable business fields.

### Overlapping downloads and multiplicity

Comparable captures are reconciled as multisets within the same Financial Account, Supported Source, and declared capture scope. A source-specific matching signature groups candidate occurrences, while a stable source order or group occurrence ordinal may pair repeated identical rows one-to-one. Three identical rows therefore remain three transaction occurrences rather than collapsing into one.

The ordinal is local matching evidence rather than durable identity. If count, order, or content changes make one-to-one pairing ambiguous, reconciliation does not guess which occurrence changed or disappeared. It records unmatched observations or withdrawal candidates according to the capture's completeness evidence.

### Source assertion lifecycle

Each source's support for a canonical projection has an append-only lifecycle:

- `observed`: a capture first supports the occurrence;
- `revised`: strong linkage shows that new evidence revises the same occurrence;
- `withdrawn`: an explicit tombstone or a comparable capture with a declared complete scope withdraws the source assertion; and
- `restored`: strong identity evidence shows that a withdrawn occurrence has reappeared.

Absence from a later file, a different query window, or an incomplete capture is not withdrawal. Lifecycle changes retain Source Capture, Source Record, Import Run, matching-rule version, actor where applicable, and decision time. They describe projection evidence rather than the transaction's economic status: withdrawal never means refund, reversal, cancellation, or deletion.

The current canonical projection is derived from effective source assertions and revisions. A transaction with no effective supporting assertion may be excluded from the default current view, but its identity, revisions, evidence, and historical visibility remain intact. One source's withdrawal does not deactivate a transaction still supported by another effective assertion.

### Transaction revisions

When provider linkage, a stable source sequence, or another unique deterministic match proves that changed evidence describes the same occurrence, OctopusBeak preserves `financial_transaction_id` and appends a Transaction Revision. Each revision retains the canonical values effective for that version, supporting Source Records, value origins, and applicable parser and matching-rule versions. Product queries may select the latest effective revision, while historical computations can remain pinned to the revision used at the time.

Without strong linkage, a changed record creates a separate Financial Transaction. Pending-to-posted is not an ordinary revision: it remains two Financial Transactions connected by a provenance-bearing `pending_to_posted` Transaction Relation, as decided in ADR 0004.

### Cross-source reconciliation

Occurrences from different Supported Sources or Source Connections may share a Financial Transaction identity only after they have been reconciled to the same Financial Account and equivalence is established by a shared provider identifier, a validated cross-source rule, or a user assertion. Fuzzy similarity alone never auto-merges them.

Transactions in different Financial Accounts remain distinct even when they describe opposite sides of one transfer or credit-card payment. Sufficient evidence may connect them with `transfer_counterpart`; it does not deduplicate them.

### Identity corrections

Discovering that previous occurrences were wrongly merged or split creates an append-only Transaction Identity Correction rather than rewriting an ID's meaning. Corrections record supporting evidence, actor, rule version, processing context, and decision time.

- A merge preserves the historical identities and records which current identity survives.
- A split supersedes an ambiguous combined identity and identifies the resulting current identities. An old ID is not silently reused for one child unless the evidence uniquely preserves that continuity.
- A supersede decision preserves the prior identity and revisions while directing current queries to the corrected identity set.
- Conflicting evidence stops automatic reconciliation until stronger evidence or a user assertion resolves it.

Parser or matching-rule upgrades may propose or create provenance-bearing corrections when their evidence standard permits; they never directly rewrite existing IDs, revisions, or Source Records.

## Plaid alignment classification

| Classification | Semantics |
| --- | --- |
| Plaid-aligned | Provider transaction IDs may establish identity; provider patch protocols may explicitly add, modify, or remove source assertions. |
| Taiwan-adjusted | Opaque stable local transaction identity; multiset occurrence matching for overlapping downloads; absence is not removal; source-specific deterministic rules preserve uncertainty and multiplicity. |
| OctopusBeak-added | Append-only source-assertion lifecycle, Transaction Revisions, cross-source reconciliation provenance, and merge / split / supersede identity corrections. |
| Excluded | Content-hash transaction IDs, set deduplication, fuzzy automatic merges, destructive row replacement, removal-as-refund, and silent ID remapping after rule upgrades. |
| Deferred | Physical schema and indexes, source-specific signatures, candidate scoring, review UX, migration, and retention policy. |

## Consequences

- Current views require projection over effective assertions and revisions rather than selecting the latest imported row alone.
- Identical real transactions survive deduplication, while repeated observations can support one stable identity when evidence is sufficient.
- Provisional duplicates remain visible until stronger evidence resolves them; this is an intentional safety trade-off.
- Reprocessing and rule upgrades remain auditable and cannot silently change historical calculations.
- Source integrations that later provide stable IDs, tombstones, or patch streams can supply stronger identity evidence without changing the local canonical identity model.

## Rejected alternatives

- Use a date / amount / description hash as identity: mutable fields and genuine identical purchases make it unstable and lossy.
- Treat matching signatures as sets: this collapses repeated same-content transactions.
- Infer removal from absence in any later capture: query scope and completeness are not reliable enough.
- Update or delete a canonical transaction in place: this destroys the evidence needed to reproduce historical views.
- Automatically merge cross-source fuzzy matches: false merges are harder to detect and reverse than provisional duplicates.
- Reuse an old ID silently after a merge or split correction: downstream references could retain the same identifier while its economic meaning changes.
