# TDCC admission: direct source precedence and passbook movements

Status: accepted

## Decision

Phase 1 of [ADR 0041](0041-tdcc-epassbook-app-protocol-source.md) admits four TDCC e-Passbook products: securities holdings, fund holdings, settlement bank accounts with their transactions, and securities passbook movements. Statement selection offers three items: securities (holdings and passbook movements), funds, and settlement accounts. The TR087 asset trend is not collected, because the canonical store has no provider-reported time series and the daily history is computed from observations.

### Direct source precedence

TDCC reports accounts maintained by banks and brokers that may also have their own supported source, such as Cathay United Bank or Yuanta Trade. [ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) keeps those identities separate, and the overview would count both. Direct source precedence resolves this for each Institution and product. While a direct source holds at least one current account for that Institution and product, every TDCC account there is covered. A covered account stays visible in its own account view, labelled with the direct source that counts it, and is excluded from totals, net worth, activity, and spending. Coverage is evaluated from data, not settings, so a direct source that is enabled but has never synced leaves TDCC counting.

This amends Source authority routing in CONTEXT.md. Overlapping routes still fail, except that a fixed precedence now decides between a direct source and an Intermediary source. No account numbers are compared and no identities merge, so this is not the user-selected or fuzzy reconciliation that ADR 0008 rejects.

### Institution mapping

Settlement accounts carry a 3-digit bank code, and broker accounts carry a broker branch code. A closed table maps every bank head-office code to its Institution and every broker branch code to its firm. An account whose code is not in the table is not admitted, and the run reports an unknown institution code for it. The other accounts proceed.

### Passbook movements

TR002 rows are Passbook movements, not investment transactions. They change Security quantity and never create a cash fact, because TDCC reports no settlement amount and quantity times price omits fees and tax. The settlement account carries the cash. Code `113` maps to buy and `123` maps to sell. Any other code rejects the Capture for that broker account. Dates are ROC `0YYYMMDD` and are converted exactly.

### Holdings and fund values

Every value comes from exactly one provider field. A missing field rejects the Capture, and nothing falls back to another field or a default.

- **Securities holdings:**
  - Quantity is TR001 item slot 7.
  - Valuation is quantity times item slot 17.
  - The effective date is the payload's `lastServerTime`.
- **Funds:**
  - Quantity is `fundSHR`.
  - Valuation is `refTWDValue` in TWD.
  - The effective date is `updateTime`.

Slot 17 and the fund fields are taken from the TedLin1993/all-set-tw reference. They are not yet confirmed against a live account that holds them. A wrong mapping is repaired by purge and recollection.

### Currency

A settlement account whose currency is not an ISO 4217 code, such as TDCC's `NAN`, is not admitted, and the run reports it. The development probe records whether such an account has a non-zero balance or any transactions.

## Considered options

- **Match accounts by bank code, last four digits, and currency, as all-set-tw does.** Rejected. It is cross-source account matching, which ADR 0008 rejects, and four digits is a weak identity.
- **Count TDCC as display-only everywhere.** Rejected. A person without a direct source would get no totals from TDCC.
- **Let the person choose which source counts per account.** Rejected. ADR 0008 rejects user-selected reconciliation.
- **Record TR002 rows as investment transactions with cash from quantity times price.** Rejected. That cash would be wrong and would duplicate the settlement account's real cash.
- **Map unknown codes to a placeholder Institution.** Rejected. CONTEXT.md forbids provisional Institution identity.

## Consequences

- A direct source that misses one of the Institution's accounts makes TDCC's copy of it uncounted, so totals can understate. They never double count.
- Securities admission gains a quantity-only path without cash. That path is limited to Passbook movements from an Intermediary source.
- Holding valuations rest on an unverified slot until a live sample confirms it.
