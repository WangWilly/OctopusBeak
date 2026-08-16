# Canonical transaction status and relation semantics

Status: accepted

OctopusBeak classifies transaction posting by account-ledger booking and keeps economic relations separate from source and projection lifecycle. [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md) amends this decision by requiring total `pending | posted` mappings, rejecting unresolved required semantics, forbidding user-confirmed financial relations, and removing canonical match candidates.

## Context

[ADR 0004](./0004-plaid-inspired-canonical-financial-model.md) introduced Financial Transaction, posting status, and Transaction Relation; [ADR 0005](./0005-conservative-transaction-identity-and-revision-semantics.md) made transaction identity and revisions append-only and conservative. The remaining ambiguity was how to distinguish pending from posted in Taiwan sources, represent cancellation and compensating movements, and retain useful but unconfirmed relation hypotheses.

The semantic comparison is documented in [Transaction posting semantics across Plaid, UK Open Banking, and Taiwan banks](../research/transaction-posting-semantics.md). Plaid is a comparison model only, and OctopusBeak does not assume Plaid transaction IDs, pending linkage, cursor patches, or enrichment.

## Decision

### Posting status follows account-ledger booking

Every Financial Transaction has `posting_status = pending | posted`:

- `pending`: source evidence describes an authorization, immediate-card record, expected entry, or reserved amount that the Institution has not yet booked to the account ledger;
- `posted`: source evidence or a verified, versioned Supported Source Integration contract establishes that the Institution recorded the entry in the account ledger.

Each Integration defines and tests a total status mapping per Source Record kind. A missing, indeterminate, or unsupported source status cancels the attempted Source Capture rather than producing `unknown`. A Taiwan credit-card transaction may be posted after merchant presentment while remaining unbilled until the statement cut-off, so optional `unbilled | billed` remains independent Credit Card Transaction Detail. Payment-network settlement, cancellation, refund, reversal, payment kind, and source-assertion lifecycle are also separate from posting status.

Pending and posted records retain separate Financial Transaction identities. Confirmed continuity is a directed `pending_to_posted` Transaction Relation from pending to posted, never a Transaction Revision, merge, or deletion. An unmatched pending transaction remains independent.

Explicitly source-reported cancellation of an unposted transaction remains provenance-bearing source fact in the first canonical model. Disappearance, Source Assertion withdrawal, or failure to find a posted counterpart never establishes cancellation; a separately booked compensating movement is evaluated as refund or reversal.

### Confirmed relations remain evidence-gated

Initial Transaction Relation semantics are:

- `pending_to_posted`: pending transaction to posted transaction;
- `refund_of`: separately booked partial or full return of value to the original transaction, which remains an economic event;
- `reversal_of`: separately booked correcting or voiding transaction to the original transaction;
- `transfer_counterpart`: a semantically symmetric connection between separate account-side transactions of one movement; and
- `installment_of`: installment transaction to an observed, evidence-backed original transaction.

Cross-account transfers retain both transactions. A counterpart involving a `credit / credit_card` account is interpreted as a credit-card payment from account types and transaction directions rather than a separate relation type; a source-reported payment with no observed other side remains source fact without a counterpart relation.

A Transaction Relation requires explicit source linkage or a validated, versioned integration contract that determines the pairing uniquely within one source-scoped identity. Source wording, opposite direction, equal or summing amounts, nearby dates, description similarity, and user input never confirm a relation.

Every relation connects two transactions, but there is no global one-to-one cardinality constraint. Evidence may establish split postings, partial or repeated refunds, compound corrections, or multi-entry transfers through multiple pairwise relations; relations do not invent amount allocations or an aggregate financial event absent from the source.

`transfer_counterpart` is semantically symmetric even if physical storage orders endpoint IDs to prevent duplicate edges. All other initial relation types have the direction stated above.

### Unconfirmed relations are absent

An optional relation that cannot be established uniquely is omitted rather than represented by an `unknown`, conflict, or Transaction Match Candidate. If an Integration attempts to emit mutually incompatible required mappings, sync admission cancels the attempted Source Capture; users cannot confirm financial relations in the first version.

## Consequences

- Taiwan Integrations need acceptance fixtures proving a total posting-status mapping for every admitted Source Record kind; an unhandled case cancels the attempted Capture.
- Credit-card authorization, merchant presentment, and statement billing remain separately queryable.
- Financial calculations may trust admitted relations without interpreting candidates or user financial corrections.
- The physical schema and migration sequence remain implementation-handoff decisions rather than part of this ADR.

## Rejected alternatives

- Treat every downloaded row as posted: collection does not prove account-ledger booking.
- Treat `unbilled` as pending: Taiwan banks use unbilled for merchant-presented activity awaiting the statement boundary.
- Add cancelled, refunded, reversed, or paid to posting status: these are source facts, economic relations, or payment semantics rather than ledger-booking states.
- Merge pending and posted records or opposite transfer sides: this destroys distinct source evidence and assumes provider identity guarantees current sources do not have.
- Store fuzzy or uncertain matches as candidates: ADR 0008 requires integrations to omit unsupported optional relations and reject unresolved required mappings before canonical persistence.
