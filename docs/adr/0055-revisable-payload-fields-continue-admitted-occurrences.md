# Revisable payload fields continue admitted occurrences

Status: accepted

## Context

Yuanta's domestic-deposit download has no provider transaction identifier. The contract builds each row's occurrence fingerprint from its composite fence (accounting date, transaction date and time, direction, amount, balance) plus its summary, note, and check number. The collision key is the composite fence with the group ordinal and carries no text.

Yuanta can rewrite a row's summary after the row is committed. On 2026-10-20 a fund dividend was collected with the summary `基金配息`. On 2026-10-21 the same row, identical in every other column, read `轉帳存入`. The recapture derived a new occurrence key under the old collision key, and the store refused it as `occurrence-conflict`. Every later run fails the whole domestic-deposit commit for that account until the row leaves the query window, about six months later.

[ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) keeps admitted identity immutable and allows a Source Assertion to be revised only through contract-established stable claim identity. [ADR 0049](0049-fubon-deposit-account-identity-continuity-by-account-number.md) rejected re-keying admitted data because the App has no mechanism to rewrite it. The store already writes a new transaction revision when a recaptured fact changes, as long as the occurrence key matches.

## Decision

A source route may declare `revisablePayloadFields` in the closed route registry. These are compact payload fields the provider may rewrite after admission. `yuanta/domestic-deposit/human-attested-v2` declares `descriptionDigest`.

On such a route, before a financial capture is persisted, the store looks up each grouped record's collision key. It continues the admitted occurrence when all of the following hold:

- exactly one admitted occurrence key holds that collision key, and it differs from the record's key;
- every admitted payload for that occurrence equals the record's payload once the revisable fields are removed.

Continuing an occurrence means the record and its financial fact take the admitted occurrence key and group fingerprint. The occurrence-group checks then run against the continued identity. The financial fact's changed description creates the next transaction revision, and the prior source assertion is superseded. A recapture whose summary is unchanged adds no revision, and the summary may later change back.

Occurrence continuity compares admitted and recaptured payloads without the route's revisable fields. Every other field, including the note and check number, must still match exactly.

## Considered options

- **Remove the summary from the occurrence key and re-key committed rows.** Rejected. Re-keying rewrites admitted identity in place, which ADR 0008 rules out, and no migration mechanism exists.
- **A new identity epoch and a Contract Purge.** Rejected. Recollection loses history the provider no longer serves.
- **A collection-time continuity read, as in ADR 0049.** Rejected. The collision key the store already holds identifies the occurrence inside the commit transaction, so a separate RPC adds no evidence.
- **Hard-code the exception by record kind, like the Fubon loan payload.** Rejected. The registry is where a route's admission behavior is reviewed.

## Consequences

- A Yuanta row whose summary is rewritten keeps one transaction. Its revision history records each summary.
- A continued occurrence keeps the key derived from the first summary admitted for it.
- A rewrite of any undeclared field still fails closed as `occurrence-conflict`.
- Other routes are unchanged until they declare revisable fields.
