# The snapshot module assembles every Current-state capture

Status: accepted

Amends [ADR 0092](0092-one-module-captures-every-current-state-snapshot.md), which left each bank its own capture builder. Keeps per-bank admission ([ADR 0054](0054-domestic-deposit-admission.md)) and the Taipei calendar day of [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md).

## Context

After ADR 0092, nine deposit capture builders (Cathay, CTBC, Fubon, HNCB, LINE Bank, Post, SinoPac, Yuanta and Yuanta foreign currency) still wrote the same object by hand:

- a source record with a placeholder content hash, then the same record again with its real hash;
- an observation that repeats the record's key, field, kind, currency and amount;
- one terminal page whose row count is the number of records;
- the capture envelope around them.

The bank-specific parts of each builder are smaller than the copied parts. They are the identity check, the digest namespaces and key parts, the compact fields, the effective time, the scope day and the page metadata.

The credit-card current used-credit snapshots of Fubon, Yuanta and E.SUN never went through the snapshot module. They read the reply with a lenient decode and an `assertIntact` check, built their captures by hand, and reported no current-balance events. Fubon and Yuanta also scoped a snapshot to its UTC day, which #359 fixed.

## Decision

**The snapshot module assembles every Current-state capture from an envelope and its balance entries.** `assembleCurrentStateCapture(kind, envelope, entries)` builds the single terminal page, one source record and one observation per entry, and the capture around them. A capture kind says how one entry becomes a record and its observation. `assembleCurrentDepositCapture` is the deposit kind; it computes each record's content hash from its compact form.

**The bank still decides every fact that differs.** The bank keeps its builder, which checks the identity and hands the module:

- the envelope: capture id, authority route, contract version, subject digest, identity, observed time, scope, provider response and page metadata;
- each entry: its source record, provider and observation keys, balance kind, source field, currency, amount, effective time, compact fields, and whether the record repeats the effective time.

Admission stays per bank, as ADR 0054 decided.

**Canonical keys stay byte-identical.** Each bank keeps its own digest namespaces and key parts, so no stored source record, observation or fingerprint changes. Every deposit-commit golden is unchanged.

**The bank still mints the capture id and the scope day.** Capture ids keep their current forms: `randomUUID()`, a bank prefix with a UUID, or SinoPac's digest. The scope day stays the bank's. `taipeiDate` in the time module is the helper for a scope day taken from an instant.

**Credit-card current snapshots follow in a later change.** They will read through the module's strict decoding, be assembled through a credit-card capture kind, and report the standard current-balance events. Their commit goldens, added before that change, will show the new events as its only intended difference.

## Considered options

- **Let the module derive every key and the capture id.** Rejected. Stored keys would change, which needs a canonical reset, and every golden would change, so a golden diff could no longer prove that nothing else did.
- **One declaration per bank and no builder.** Rejected. Identity checks and key parts differ between banks in ways a declaration would have to grow a field for each time.
- **Separate assembly functions for deposits and credit cards.** Rejected. The two captures share the envelope and page shape, and two functions would let the page and envelope drift again.

## Consequences

- A bank's builder no longer writes the placeholder hash, the observation's repeated fields or the page shape.
- A new Current-state source writes only its envelope and entries.
- A page whose row count is not its number of records cannot be expressed. No bank needs one.
