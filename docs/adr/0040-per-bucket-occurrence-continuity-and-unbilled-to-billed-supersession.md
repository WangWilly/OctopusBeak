# Per-bucket occurrence continuity and unbilled-to-billed supersession

Status: accepted

Amends the queried-bucket continuity rule of [ADR 0034](./0034-workflow-semantic-occurrence-disambiguation.md) and applies the withdrawal-by-absence rule of [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md) to credit-card purchases that post with changed content. Motivated by [issue #186](https://github.com/WangWilly/OctopusBeak/issues/186).

## Problem

A credit-card purchase is fingerprinted by its content (instrument, consume date, direction, amount, currency, description). When the issuer rewrites the merchant text or finalizes a foreign-exchange amount at posting, the billed row has a new fingerprint, a new occurrence key, and therefore a new Financial Transaction identity. The unbilled transaction stays admitted beside it.

ADR 0034 made occurrence-group counts comparable only between captures with an identical queried-bucket inventory. Credit-card captures carry a rolling window (E.SUN months, Fubon and Yuanta statement periods), so the inventory changes on almost every run. A rolled window therefore had no comparable prior capture, the member-loss guard never ran, and the stale unbilled copy stayed current. On the same window the guard ran and rejected the capture, so the run failed instead.

## Decision: continuity is per occurrence and per queried bucket

Each admitted occurrence is located by the query bucket of its most recent inventoried capture. A later complete capture is expected to contain that occurrence again only when it queried that bucket. The guard compares, per semantic group, the number of such expected occurrences with the number present. Absence from an unqueried bucket is not evidence; absence from a queried bucket is a loss and rejects the capture unless correction evidence covers it.

This replaces "counts are comparable only when the full inventory is identical" in ADR 0034. The inventory still records exactly which buckets a capture queried, including empty ones, and still does not participate in occurrence identity. The Fubon billed-progression check applies the same per-bucket rule to billed members.

An occurrence whose source assertion is withdrawn is no longer expected. Only the generic guard and the credit-card gate below read this rule; both call one query, `listPGliteExpectedOccurrences`.

## Decision: an unbilled purchase may be withdrawn by proven supersession

A prior unbilled transaction that vanished from a complete capture may be withdrawn when, inside the same commit transaction, a billed transaction proves it continued. All of the following must hold:

- same source subject and the same occurrence scope key;
- same Card Instrument;
- same occurrence partition date (the consume date);
- the vanished transaction's latest lifecycle billing status is `unbilled`;
- the vanished occurrence's last known bucket was queried by this capture, so its absence is evidence (for Fubon and Yuanta this is the complete unbilled grid; for E.SUN it is the month bucket of a complete timeline capture);
- the successor is `billed` in this capture, was never observed before on this subject, and is a member of a Billing Statement admitted by this capture;
- both have the same transaction direction; the amount may differ;
- the pairing is exactly one vanished unbilled transaction to exactly one new billed transaction for that scope, instrument, and date.

Any other multiplicity is ambiguous. The gate then pairs nothing and the continuity guard rejects the capture with the existing occurrence-conflict error, so the ledger is unchanged.

When the pairing holds the store, in one transaction:

1. admits the capture and its facts with the withdrawn member excluded from the expected count;
2. appends a `withdrawn` transition to the vanished transaction's latest source assertion, with this capture, scope, and commit as provenance;
3. records a `unbilled_to_billed` Transaction Relation from the withdrawn transaction to its billed successor, with the billed source record as evidence.

The withdrawn transaction leaves the current projection through the existing transition rule. Its revisions, source records, and lifecycle rows remain as history. A later capture does not expect it again because its assertion is withdrawn, and does not withdraw or relate it twice.

`withdrawn` is used rather than `superseded` because ADR 0008 reserves `superseded` for a changed value inside one transaction's own assertion lineage, while withdrawal is loss of source support for a stable claim. `unbilled_to_billed` is a new relation kind rather than `pending_to_posted` because both rows are `posted` in ledger-booking terms; billing status is lifecycle evidence, not posting status, and [ADR 0007](./0007-canonical-transaction-status-and-relation-semantics.md) defines `pending_to_posted` on posting status.

## Boundaries

- The pairing evidence crosses the store seam as data: `occurrenceSupersessions: { withdrawnTransactionId, successorOccurrenceKey }[]` on the financial commit request. The credit-card commit resolves it from lifecycle rows and the request before the generic admission runs.
- The rule holds for every provider on the shared credit-card store path. Fubon and Yuanta captures already carry statement membership, instrument keys, and an `unbilled` bucket; E.SUN carries month buckets and settled statement membership.
- No user action, description similarity, or amount equality establishes the pairing. Direction change, instrument change, a successor outside every statement, and any many-to-one or one-to-many candidate set fail closed.
- Existing fixtures that dropped a group while still querying its bucket were adjusted to query only the buckets they claim aged out; under this rule such a capture is a loss.
