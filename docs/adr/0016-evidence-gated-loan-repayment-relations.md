# Evidence-gated loan repayment relations

Status: accepted

OctopusBeak resolves loan repayments across independently captured deposit and loan histories with source-scoped evidence, bounded completeness, and append-only support. This decision amends [ADR 0007](./0007-canonical-transaction-status-and-relation-semantics.md) by applying `transfer_counterpart` to exact loan-payment counterparts and adding a provenance-bearing settlement group for source-established collective membership that cannot be represented truthfully as pairwise relations. It preserves [ADR 0008](./0008-source-scoped-lineage-and-strict-canonical-admission.md): fuzzy candidates and end-user-confirmed financial relations remain outside canonical admission.

## Context

Issue [#136](https://github.com/WangWilly/OctopusBeak/issues/136) adds canonical loan collection for Taipei Fubon and Yuanta. Initial live observations showed that repayment rows and deposit outflows are not always joined by a visible transaction identifier. Fubon observations produced same-date, same-amount possibilities; the initial Yuanta date-and-amount diagnostic did not. Later Yuanta page inspection established a stronger provider contract: the loan-statement selector exposes the full loan account and domestic-deposit rows use `00` followed by that same account in the Institution-generated `備註` field. Date and amount similarity still cannot establish that two independently booked transactions are the same movement.

The first loan implementation also derives loan identity separately from deposit identity and only runs counterpart inference inside selected workflows. That prevents independently captured products of the same bank authorization from sharing a reliable Source Connection, and it makes relations depend incorrectly on one task-run boundary.

Taiwan bank pages may expose repayment destinations, auto-debit mandates, transaction codes, Institution-generated notes, masked accounts, limited query horizons, or none of these. The model must distinguish what the source proves from what a matching algorithm merely finds plausible.

## Decision

### Source Connection is product-independent

A Source Connection identifies one bank login or authorization identity across deposit, loan, credit-card, and other product workflows. It is not a workflow run, session, query range, schedule, password version, OTP method, CAPTCHA solver, or device-local random identifier.

The first version derives a deterministic, Integration-domain-separated, memory-hard identity key from contract-normalized stable login identifiers. Passwords, OTP values, solver state, and sessions are excluded. Changing a stable bank login identity creates a new Source Connection; changing secrets, authentication mechanics, schedule, statement selection, or query range preserves the existing connection. The deterministic contract intentionally supports clean-device reproduction without migrated local state and accepts the documented offline-correlation risk of having no portable secret.

Each relation endpoint remains valid in its own Identity Epoch. Endpoint epoch keys need not be equal, but relation resolution never merges or reconciles account identities across epochs.

Existing affected Fubon and Yuanta deposit and loan canonical scopes are purged precisely and recollected under the corrected identity contract. Credentials and automation settings are preserved, and other Institutions are not affected.

### Counterparty account evidence is generic and exact

Domestic deposit, foreign-currency, and loan Integrations capture Transaction Counterparty Account Evidence whenever the provider supplies it. Evidence records the exact source value, a contract-normalized full value, a comparable digest, Institution, transaction role (`originator | beneficiary`), purpose such as `loan_repayment`, and supported scope (`loan_contract | shared_collection`). The full account value is stored in the local canonical SQLite database with the same protection boundary as other transaction source text; relations reference its evidence and digest rather than duplicating it.

A shared collection account may be a Verified Repayment Destination even though it does not identify one loan by itself. A masked account is not equivalent to a full account. If implementation or live validation encounters only a masked repayment or counterparty account, work stops for an explicit design decision; it must not silently use a suffix as an exact match or fall back to a weaker contract.

For Yuanta's versioned first contract, a loan selector is admissible only when its option value and visible label contain the same single 14-digit full account. A domestic-deposit `備註` is admissible only when its complete normalized source text is exactly `00` plus 14 digits. Persistence retains the full 16-digit source value and its 14-digit comparison normalization. Missing, masked, malformed, embedded, or mismatched values fail closed. This contract removes the need to visit the loan overview page when the loan-statement selector itself supplies the full account.

### Evidence determines admission strength

The evidence hierarchy is:

1. An Institution transaction identifier, authorization identifier, or explicit cross-reference that binds two specific Financial Transactions admits an exact relation without requiring complete surrounding history.
2. A Verified Repayment Destination establishes repayment purpose, not an individual transaction pair. Complete captured coverage must support either exact endpoint resolution or collective settlement membership.
3. Only when no repayment destination is obtainable may a versioned Human-attestation Contract use the combination of date, exact same-currency amount, and a live-verified stable Institution-generated loan-payment note or code. User-authored notes are excluded.
4. Date and amount alone produce neither a canonical relation nor a retained match candidate.

The Human-attestation Contract is an Integration contract created from reviewed live behavior and sanitized fixtures. The first version has no end-user-facing relation-attestation UI and no runtime prompt that lets a user admit a financial relation.

Account or explicit transaction linkage takes precedence over amount equality. A source-proven relationship may be admitted when amounts differ, but the difference remains unexplained unless the source separately proves a fee, currency conversion, or allocation. Date comparison follows an Institution- and page-specific date contract; there is no universal same-day or plus-or-minus-two-day admission window.

### Mandates establish account relationships, not every payment

An auto-debit or repayment setting may establish that a funding account is authorized for a loan or Verified Repayment Destination. Each individual outflow still requires an Institution-generated transaction note or code supported by the Integration contract.

Source-provided effective and end dates bound mandate validity. A page that only says the mandate is currently active proves the state at its observation time and is not applied retroactively. Repeated observations support only observed continuity. Cancelling a mandate ends future support and does not erase source-backed historical relations.

### Completeness is bounded and recorded

Completeness means complete coverage of an Institution-visible interval, not lifetime account history. Captures record the source-available range, requested range, completed range, and pagination completion.

Exact source linkage between two transaction endpoints does not require complete surrounding history. Any resolution that relies on matching, uniqueness, or collective membership does. Account-backed resolution searches all retained canonical history without a fixed day window, but a missing page, failed product capture, partial all-statements result, or incomplete necessary overlap prevents a uniqueness claim.

Yuanta domestic-deposit range capture follows calendar arithmetic rather than fixed day counts: one month and three months are subtracted as calendar months with month-end clamping. This keeps rows at the provider's inclusive boundary inside the recorded complete interval.

Missing data never proves that a prior relation is absent. Later access to older or broader bounded history may supersede the current judgment while preserving its earlier support and provenance.

### Exact counterparts reuse the generic relation

An exact deposit-outflow and loan-payment pair uses the semantically symmetric `transfer_counterpart` Transaction Relation. Its loan meaning comes from endpoint account types, directions, `payment.loan` Transaction Kind, and source evidence rather than a product-specific exact-relation type.

Relation endpoints are Financial Transactions. Principal, interest, and fee amounts attached to a loan transaction may participate in reconciliation but are never relation endpoints.

When source evidence establishes collective membership but cannot establish pairwise endpoints, a Loan Repayment Settlement Group contains one or more deposit-outflow Financial Transactions and one or more loan-payment Financial Transactions. It preserves the known membership without inventing allocation, ordering, or pairings. It is canonical source-backed knowledge, not a fuzzy candidate.

### Resolution is asynchronous to workflow runs and append-only

Relation resolution runs idempotently after any relevant deposit or loan Capture commits and reads the retained canonical history of the Source Connection. A later standalone Capture may complete relations against earlier captures; an all-statements run is not an identity or relation boundary.

An unchanged result adds support provenance without duplicating the relation or group. A later successful complete resolution may supersede a current exact relation or settlement group with a better-supported exact relation or group. Earlier judgments remain in append-only history. A failed or incomplete resolution changes neither existing support nor the current projection.

Every newly persisted resolution judgment owns a dedicated, strictly increasing `relation_resolution` Canonical Financial Commit. It must not borrow the commit of the latest source capture. Schema v13 backfills pre-v13 resolution runs onto new migration-time knowledge points so a historical cutoff cannot observe a relation before the system knew it. An idempotent rerun that persists no new judgment creates no commit.

## Consequences

- Fubon and Yuanta live validation must inspect list, detail, and repayment-setting pages for full accounts, transaction or authorization identifiers, stable Institution-generated notes or codes, hidden identifiers, query limits, and mandate dates.
- Sanitized fixtures version every provider-specific account, note, date, amount, and completeness rule.
- Deposit and loan Capture results need shared Source Connection identity and recorded coverage even when the workflows run independently.
- Canonical persistence needs generic counterparty account evidence, bounded coverage evidence, append-only resolution support, and settlement-group projection.
- Financial transactions are never duplicated merely to manufacture a counterpart.
- A masked-only repayment account is an explicit implementation stop, not an admissible exact account match.

## Rejected alternatives

- Random device-local Source Connection IDs: they do not reproduce on a clean device.
- Matching Source Connection by workflow run or equal Identity Epoch strings: product captures and account epochs are independent.
- Same-date or fixed plus-or-minus-day matching: public settlement behavior and live pages do not support one universal window.
- Date-and-amount candidates in canonical storage: similarity is not financial relation evidence.
- A full repayment destination as proof of an individual transaction pair: it proves purpose but may leave multiple endpoints possible.
- Arbitrarily pairing indistinguishable equal amounts: it invents precision; a settlement group preserves only proven membership.
- User-facing relation confirmation in the first version: relation admission remains an Integration responsibility.
- Digest-only counterparty account persistence: the accepted local-data policy retains exact full account evidence as well as normalized and digested forms.
- Treating principal, interest, and fee components as relation endpoints: they are amount decomposition of a Financial Transaction.
