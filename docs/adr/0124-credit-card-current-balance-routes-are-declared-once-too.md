# Credit-card current balance routes are declared once too

Status: accepted

Extends [ADR 0123](0123-current-deposit-routes-are-declared-once-in-the-ledger-contract.md) to the four credit-card current used-credit routes. Keeps [ADR 0107](0107-the-snapshot-module-assembles-every-current-state-capture.md): each issuer still names its route key and mints its digests. Holds [ADR 0062](0062-credit-card-query-inventory-and-user-triggered-reset.md): a superseded identity epoch is still refused until a Canonical Reset.

## Context

Each credit-card current balance route was written by hand in the same places ADR 0123 names for deposits. The admission table checked captures. The registry repeated the route key, namespace, contract version and superseded identity epochs. The E.SUN, Fubon and Yuanta workflows repeated host, path and Cache-Control directives in their response declarations.

## Decision

**`CREDIT_CARD_CURRENT_BALANCE_ROUTE_CONTRACTS` in `src/ledger/canonical/credit-card-current-balance-admission.ts` declares each route once.** The table is `as const`, so its keys form `CreditCardCurrentBalanceAuthorityRoute`, the type of a capture's authority route. Everything else follows ADR 0123. Only these points differ.

- **The table stays in the admission module.** It was already in the canonical layer, and the registry imports it without a cycle. A separate module would hold nothing new.
- **The registry also derives `supersededIdentityEpochs`.** It reads the namespace's identity epochs from `CREDIT_CARD_IDENTITY_EPOCHS`, the same map the admission uses to refuse a superseded epoch.
- **E.SUN v1 stays.** No workflow emits it, but stored captures still name it, so its contract and registration remain and are derived like the rest.
- **Digest inputs stay literal.** E.SUN's route key and the Fubon and Yuanta record key prefixes feed `sourceRecordKey` and `providerKey`, so changing them would change persisted keys (ADR 0107).

## Consequences

- The derived registrations are identical to the hand-written ones, in the same order. Opening an existing store installs nothing new.
- No persisted value changes. The credit-card commit goldens are unchanged.
- A misspelled credit-card current balance route in a builder is a type error.
