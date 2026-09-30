# Fubon loan semantic occurrence identity

Status: accepted

Fubon loan Source Records use a stable semantic occurrence identity rather
than the row position returned by the provider. The existing Fubon v2
contract is corrected in place; no new identity or contract version string is
introduced. This is an intentionally incompatible correction for existing
Fubon loan data and requires that data to be removed before cutover.

## Context

The Fubon loan integration does not expose a stable provider transaction ID.
The implementation therefore derives a source occurrence key from the
captured row. The previous implementation included the row index in that key
and in the collision identity. A rolling query can omit an older row, causing
every retained row after it to receive a new position. The retained financial
fact then reuses a collision key previously belonging to another occurrence,
and strict canonical admission rejects the Capture with
`commit/admission-occurrence-conflict`.

This violates the source-scoped identity and fail-closed admission rules in
[ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md).
It also makes ordinary provider pagination and date-window movement appear to
be a financial identity change. [ADR 0016](./0016-evidence-gated-loan-repayment-relations.md)
requires Fubon loan observations to retain source-backed evidence, while
[ADR 0025](./0025-canonical-financial-commit-execution.md) requires a failed
financial admission to leave no partial canonical effect.

The provider supplies transaction date, source event information, direction,
amount, and account scope, but not enough evidence to infer a correction when
an amount changes. The provider may also return a post-transaction balance
and display wording that can evolve independently of the transaction's
financial identity.

## Decision

### Semantic identity replaces positional identity

For `fubon-loan-transaction`, the occurrence identity core is the tuple:

- the normalized Fubon loan account;
- the normalized transaction date;
- the standardized provider event code;
- the transaction direction;
- the normalized exact amount and currency; and
- an ordinal scoped only to rows with an identical preceding fingerprint.

The fingerprint excludes the provider row index, pagination position, capture
time, post-transaction balance, and display wording. The existing Fubon v2
contract/key family remains the named contract; its implementation is
corrected in place rather than silently introducing a second version string.

Rows are ordered from the oldest normalized transaction date to the newest.
For rows on the same date, the provider's relative page order is retained as
the tie-breaker. The duplicate ordinal is assigned after all pages in the
complete Source Capture have been combined, and only within an identical
fingerprint group. Inserting, removing, or reordering unrelated rows cannot
change an existing occurrence identity.

The ordinal preserves distinct occurrences when the provider returns multiple
transactions with the same semantic fingerprint. It is not a global row
sequence, a per-page sequence, or a number continued from historical ledger
state. If the provider swaps indistinguishable duplicate rows, the source
does not provide evidence to establish which historical balance observation
belongs to which duplicate; the implementation preserves the provider's
observed order without using balance as identity.

### Balance and source wording are evolvable evidence

Balance is not part of transaction identity. A later complete Capture may
report a different post-transaction balance for the same semantic occurrence.
The Fubon-specific admission policy may accept that change when the financial
core remains equal, append a balance observation at the original transaction
date as its effective time, and use the later Capture commit sequence or
observation time as knowledge time. Earlier observations remain in append-only
history; current projections may select the most recent knowledge version.

An identical balance observation does not create a duplicate revision. The
later Capture still contributes source provenance. Balance comparison uses
the normalized balance value, currency, effective date, balance kind, and
evidence/time precision.

The provider's raw display label is retained as source evidence. Canonical
description is derived from the standardized event code. Changes to spacing,
punctuation, or other non-identity wording therefore do not create a
financial transaction revision.

### Evolution is narrow and fail closed

The Fubon loan admission policy may tolerate a changed source payload only
after comparing the stable financial core. That core includes occurrence
identity, effective date and time precision, posting status, event kind and
standardized event code, direction, normalized amount and currency, duplicate
ordinal, and all principal, interest, fee, or other financial components.

Only `balanceSourceEvidence` and non-identity source wording may evolve. A
change to account, date, event code, direction, amount, currency, duplicate
ordinal, or any other financial component is a different occurrence or an
unsupported content change; it is not treated as a revision of the existing
occurrence. Where the evidence cannot distinguish the cases, canonical
admission fails closed and the item's transaction is rolled back. The system
does not display or create a “possibly related” relationship for an amount
change.

This allowlist is specific to Fubon loan records. Yuanta and every other
provider retain their existing identity and admission contracts.

### Cutover and ownership

Existing Fubon loan data was written under the defective positional identity.
The deployer must remove the complete affected Fubon loan canonical closure
before the corrected implementation is used against that ledger. This
includes the dependent captures, source records, assertions, observations,
relations, projections, and commit closure covered by the repository's
canonical purge semantics.

The implementation does not add a legacy-data preflight, automatically
migrate positional keys, guess mappings, or purge data. The user/deployer
owns the cleanup and must complete it before production cutover. No other
provider, product, or canonical ledger scope is included in that cleanup.

Delivery is staged:

1. Implement the corrected Fubon identity and evolution policy, then pass
   focused contract tests, regression tests, and synthetic Electron
   validation.
2. The deployer removes the old Fubon loan canonical closure using the
   approved cleanup procedure.
3. A separately authorized live Fubon synchronization verifies the cutover.

## Consequences

- Rolling date windows no longer change the identity of retained Fubon loan
  transactions merely because earlier rows disappeared.
- Complete captures can preserve multiple identical semantic transactions
  without making balance or display wording an identity surrogate.
- Balance corrections remain observable at the original financial effective
  date while retaining when the system learned them and the source support
  for each observation.
- A provider amount, date, direction, event-code, or other financial drift
  still fails closed or creates a distinct occurrence according to the
  existing admission contract; the implementation never guesses a
  correction.
- The correction is deliberately incompatible with old positional keys.
  Retaining the existing v2 strings means the database cannot distinguish
  old and corrected key material by version alone; safe rollout therefore
  depends on the deployer's complete pre-cutover removal. This is a known
  compatibility risk, not an implicit migration guarantee.
- No generic loan admission relaxation is introduced, so Yuanta's current
  semantic contract and duplicate handling remain unchanged.

## Rejected alternatives

- Keep the row index in the occurrence key: rolling windows would continue to
  reuse collision keys for different financial occurrences.
- Use the full table row index or page-local index as a duplicate ordinal:
  unrelated row movement and pagination boundaries would change identity.
- Use balance, display text, or capture time as identity: these are mutable
  observations or provenance, not evidence of a distinct transaction.
- Match an amount change to an old occurrence and create a revision: without
  a provider transaction ID, that would guess correction semantics and could
  erase the possibility of a second real transaction.
- Use a database-wide historical ordinal: identity construction would depend
  on mutable ledger state and would not be reproducible from one complete
  Source Capture.
- Automatically migrate or reconcile old positional records: a guessed
  mapping could join new and old financial facts incorrectly.
- Keep old and new records in parallel: this would expose two incompatible
  identity epochs as if both were canonical facts.
- Add a legacy preflight or automatic purge: deployment ownership is explicit,
  and implementation-side cleanup would expand the change beyond the
  identity correction.
- Change Yuanta or introduce a generic loan algorithm: provider contracts
  have different evidence and duplicate semantics, so broadening the scope
  would change unrelated behavior.

## Verification

Acceptance requires all of the following:

- A rolling-window capture `[A, B] -> [B]` commits successfully and preserves
  B's occurrence, collision, and provider identities.
- Reordering unrelated rows does not change existing identities.
- Date ordering and same-day provider order produce stable duplicate ordinals
  within identical fingerprint groups, and repeated identical transactions
  remain distinct.
- A balance-only change does not create a second financial transaction; it
  creates only the permitted balance observation evolution. Repeating the
  same balance adds provenance without another revision.
- Display wording changes do not create a transaction revision.
- Amount, date, direction, event code, currency, duplicate ordinal, or other
  financial-core changes do not use the evolution allowlist.
- Unknown or non-allowlisted financial drift fails closed with complete
  transaction rollback.
- Yuanta and other provider admission, migration, repair, projection,
  relation, read-only, purge, spending, typecheck, build, and full test
  behavior remain unchanged.
- Synthetic Electron validation passes before the deployer performs cleanup;
  the separately authorized live Fubon synchronization is the final cutover
  evidence.
