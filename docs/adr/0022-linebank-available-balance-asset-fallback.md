# Include LINE Bank available balance when ledger balance is absent

Status: accepted

This decision supersedes the earlier overview statement in [ADR 0021](./0021-source-key-and-provider-account-number.md) that available observations never enter asset totals. That statement remains true for providers outside this explicitly selected LINE Bank policy.

## Context

LINE Bank's authenticated account selector requests `GET /v1/account/common/payables?featureTypeCode=01`. The public accessibility bundle labels `dpstAcctList[].wdrwAvblAmt` as 可用餘額. The same response also exposes `acctBal`, but the published binding does not establish that field as a 帳面餘額 observation.

The product decision is to include a proven LINE Bank available amount in the asset total when the corresponding account and currency have no current ledger observation. The source identity remains the existing admitted LINE Bank account identity (`acctNbr:arrId`), and the observation keeps `balanceKind: available` with its provider field and HTTP Date evidence.

## Decision

The LINE Bank current-balance adapter admits only `wdrwAvblAmt` from a complete, HTTP 200 payables response with `featureTypeCode=01`, a valid HTTP Date, and the provider cache policy. Numeric JSON tokens are parsed from `response.text()` with their original lexical value retained before exact decimal admission. Every account entry must have a complete twelve-digit `acctNbr`, an `arrId`, and an exact `wdrwAvblAmt`; a missing amount is an error and is never treated as zero. The domestic route emits TWD rows only; non-TWD entries are structurally checked but remain outside this bounded route.

Overview aggregation applies the fallback per account and currency:

1. A `ledger` observation is selected whenever one exists.
2. A LINE Bank `available` observation is selected only when no ledger observation exists for that account and currency.
3. Available observations from other integrations are excluded from this fallback.

The selected value remains labeled `available` in the canonical trace and the interface explains when the asset total uses this basis. Historical/current projection cutoffs continue to select observations by their provider effective instant and knowledge point; the fallback does not rewrite ledger observations or create a ledger observation.

## Consequences

The asset total reflects the user's selected LINE Bank product policy even when the provider only supplies an available balance. Ledger priority prevents double counting when both observations exist. Source lineage retains the route, response digest, HTTP Date, exact amount, account identity, `balanceKind`, and `wdrwAvblAmt` source field for review.

The policy is intentionally narrow. It does not infer semantics for `acctBal`, other provider fields, or other integrations, and it does not make available funds interchangeable with transaction-history running balances.

## Rejected alternatives

- Treating `acctBal` as ledger balance without a published source binding.
- Adding every provider's available balance to assets, which would change unrelated product policies.
- Summing ledger and available observations together, which would double count one account.
