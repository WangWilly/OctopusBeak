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

## 2026-10-25 amendment: an unbilled purchase that vanishes without a successor

### Problem

An issuer can cancel an unbilled authorization before billing, for example a released hotel deposit or a voided order. The authorization then leaves the complete unbilled listing, and no billed row continues it. Fubon and Yuanta keep unbilled rows in one `unbilled` bucket that every capture queries. Under the rule above, every later capture therefore expected the authorization and was rejected. The source stayed blocked until a user purged it. E.SUN was blocked the same way until the month aged out of its timeline.

### Decision: absence withdraws source support when nothing could continue the purchase

Under [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md), absence from a comparable, declared-complete scope may withdraw a Source Assertion. A vanished member that the pairing above does not resolve is withdrawn only when all of the following hold:

- the capture is complete, and it queried the bucket where the member was last observed;
- the member's latest lifecycle billing status is `unbilled` (a billed member belongs to an immutable statement, and its absence is still a loss);
- the member's Card Instrument is listed in this capture (if a whole card is absent, nothing is inferred);
- this capture contains no billed transaction that is new to the source subject and shares the member's scope and consume date, on any card and in either direction.

That last condition is wider than the pairing on purpose. Any such row could be the member's continuation, so the guard keeps rejecting rather than guessing. As a result, every negative case listed above still rejects.

This rejection does not clear by itself. A rejected capture never admits the candidate, so the candidate stays new on every later capture. E.SUN stays rejected until the date leaves its timeline. Fubon and Yuanta query a constant `unbilled` bucket, so they stay rejected until a purge.

The reverse trade-off: a continuation that the pairing misses is withdrawn rather than rejected. Examples are a successor booked on a later consume date, or one whose statement bucket this capture did not query. If its billed row is in this capture, that row is admitted as a new transaction. Otherwise it arrives in a later capture. Either way, totals end up correct, but lineage and annotations from the unbilled transaction do not carry over, and no relation is recorded.

When the conditions hold, the store, in the same transaction as the capture:

1. admits the capture with the member excluded from the expected count;
2. appends a `withdrawn` transition to the member's latest source assertion, with this capture, scope, and commit as provenance.

It records no relation, and it never records cancellation, refund, or reversal ([ADR 0007](./0007-canonical-transaction-status-and-relation-semantics.md)). The commit result reports `withdrawnTransactionCount`. The request carries the evidence as `occurrenceWithdrawals: { withdrawnTransactionId }[]`.

### Decision: reassertion restores, except after supersession

When a capture lists a withdrawn occurrence again with an unchanged revision, the store appends a `restored` transition, and the transaction returns to the current projection. Before this amendment, an unchanged revision gained provenance only, so a withdrawn transaction stayed withdrawn even when the source listed it again.

A member withdrawn by supersession has an `unbilled_to_billed` relation, and its billed successor already carries the purchase. If such a member is listed again, the credit-card commit is rejected with `revision-conflict` instead of being restored.
