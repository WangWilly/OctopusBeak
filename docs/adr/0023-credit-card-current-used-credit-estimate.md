# Estimate issuer-aggregate credit-card used credit

Status: accepted

## Context

Authenticated credit-card pages expose a provider's current issuer-aggregate
credit usage, but this value is not a posted statement balance. YuanTa and
E.SUN expose an explicit 已使用額度/已用額度 field, including unbilled
consumption. Taipei Fubon exposes the credit limit and available credit, so
its current used-credit value must be derived from those two fields.

The account is the existing issuer aggregate identified by the source
connection, identity epoch, credit-card stream, and opaque source account key.
Masked card numbers remain card-instrument evidence and never become separate
financial accounts.

## Decision

Admit one `credit_used` observation per issuer account and currency for each
provider snapshot. Every observation is explicitly marked `estimate` with a
provider-specific basis:

- YuanTa: the provider-reported `已使用額度` value.
- E.SUN: the provider-reported aggregate-row `已用額度` value.
- Taipei Fubon: exact decimal `正卡人信用額度 - 正卡人可用額度`.

The immutable source record keeps the provider field, HTTP response metadata,
effective HTTP Date, exact amount, estimate basis, and formula. Fubon also
keeps both exact operands. Signed results are preserved; the adapter never
silently clamps a negative difference to zero. Current and historical
projections select the latest observation by provider effective instant and
knowledge point, while repeated equal observations at the same instant are
deduplicated and contradictory amounts are rejected.

The overview may include this amount in liabilities only under the product
label `估算負債（含未請款消費）`. It must remain distinguishable from a
guaranteed posted/current-outstanding balance and must not use loan rows,
statement totals, cash-advance limits, or unrelated bill fields as a fallback.

## Consequences

The product can show a bounded current liability estimate while preserving a
reviewable provider fact and formula. Issuer aggregate identity prevents
double-counting supplementary cards. Because the estimate has its own balance
kind and detail row, future providers or a posted-balance source can be added
without rewriting the existing statement or loan semantics.
