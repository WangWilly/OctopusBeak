# Canonical transaction money, currency, and time

Status: accepted

## Context

Current Taiwan bank, foreign-currency, credit-card, and loan sources expose different sign conventions, debit/credit columns, original and booked amounts, exchange-rate fields, and combinations of transaction, authorization, posting, accounting, FX, and billing dates. They usually provide local Taiwan civil dates or times without an explicit zone. Copying a provider-specific signed amount or coercing every date to an apparently exact timestamp would make cross-source calculations ambiguous and could manufacture precision the source did not provide.

This decision refines the Financial Transaction and Credit Card Billing Statement boundaries in [ADR 0004](./0004-plaid-inspired-canonical-financial-model.md). Plaid remains a comparison reference only; OctopusBeak does not adopt Plaid field names, positive-outflow convention, or overloaded pending/posted `date` semantics.

## Decision

### Booked money and direction

Every Financial Transaction records the exact non-negative magnitude actually booked to its Financial Account, its explicit denomination, and one required direction: `inflow` or `outflow`. Direction describes money crossing the account boundary rather than asset, liability, balance, or net-worth change.

- Deposits and refunds enter an account.
- Withdrawals and card purchases leave an account.
- Credit-card and loan payments enter the liability account.
- Loan disbursements leave the loan account; a corresponding deposit-account transaction remains a separate inflow and may be linked by `transfer_counterpart`.

Reports may derive positive inflows and negative outflows, but canonical amounts never carry a provider-specific sign convention. Transfers retain both account-side transactions and are not deduplicated into one signed event.

Every Supported Source Integration must define and test a versioned, unambiguous mapping from its amount signs, withdrawal/deposit columns, and debit/credit codes to canonical direction. If the fields are missing, contradictory, or cannot be interpreted uniquely, the immutable Source Record remains available with a projection data issue but is not promoted to a Financial Transaction. Canonical direction therefore has no `unknown` value.

### Exact values and denomination evidence

Canonical amounts and rates use an exact decimal domain type and never IEEE-754 binary floating point. Source formatting remains in the immutable Source Record; the canonical value is a lossless parsed decimal, and presentation rounding never changes it. The later physical schema may use decimal text or coefficient plus scale, but not a lossy `REAL` representation or one universal cents convention.

Fiat denominations use ISO 4217. A non-ISO denomination belongs to a distinct controlled scheme rather than masquerading as an ISO currency code.

Transaction currency is established in this evidence order:

1. an explicit transaction-row denomination, recorded as `source_fact`;
2. a currency-specific Source Capture or query scope, recorded with its provenance; or
3. a versioned fixed-currency Integration contract.

A Financial Account default currency is not transaction evidence and never overrides the booked amount denomination. A Source Record without a usable booked amount, direction, or traceable denomination does not enter the complete Financial Transaction projection.

### Original amount and conversion evidence

An optional Original Transaction Amount preserves the merchant, counterparty, or source denomination before conversion. It never replaces the amount booked to the Financial Account.

Optional Transaction Conversion evidence may record:

- original and booked exact amounts;
- explicit base and quote denominations;
- a source-reported rate;
- a separately derived implied rate;
- a source-reported conversion date;
- the origin and applicable parser or rule version; and
- a `consistent` or `conflicted` comparison under a versioned rounding tolerance.

A rate derived from the two amounts is not presented as a bank rate. When the reported and implied rates disagree, the booked amount remains authoritative for account reconciliation and both rates remain visible. OctopusBeak does not fill missing conversion facts from a later market rate or infer a fee from the discrepancy. A fee becomes another Financial Transaction only when the source explicitly itemizes it.

### Transaction date observations

Occurrence, authorization, posting, and accounting dates are separate provenance-bearing Transaction Date Observations. Each observation retains:

- role: `occurred`, `authorized`, `posted`, or `accounting`;
- source-local calendar date;
- optional source-local time;
- source timezone;
- UTC-normalized timestamp;
- precision, including `date` for a date-only value; and
- time origin, including `source_reported` or `defaulted_local_midnight`.

All current Supported Source Integrations declare `Asia/Taipei` for otherwise unzoned transaction dates and times. A complete local date/time is normalized to UTC. A date-only value may use `00:00:00 Asia/Taipei` as its UTC storage anchor, but it must keep `precision = date` and `time_origin = defaulted_local_midnight`. Product display and ordering must not claim that this anchor is a source-reported event time. Future Integrations must declare their own versioned source-timezone rule rather than inheriting the current Taiwan default from the user's device or system timezone.

Every Financial Transaction also has one required local `effective_on` date for default ordering, period queries, and reporting. After source fields are mapped to semantic roles, the common priority is:

1. `occurred`;
2. `authorized`;
3. `posted`;
4. `accounting`; then
5. `inferred` only when no reliable transaction observation exists.

The selected basis and rule provenance remain explicit. `effective_on` is a query projection and does not replace the underlying observations. Import time does not become a transaction date merely because source dates are absent.

### Billing dates

Statement period, issue date, and payment due date belong to the Credit Card Billing Statement, not to Transaction Date Observations. Transactions relate to an evidence-gated settled Statement through membership. A source-derived `billed` status may exist without enough evidence to establish a Statement; an unbilled list, filename, query month, export, or Source Capture never establishes one by itself.

## Consequences

- Financial calculations can reproduce exact booked values without provider sign or floating-point ambiguity.
- Integration acceptance must include fixtures for signs, debit/credit meanings, denomination evidence, timezone normalization, date-only anchoring, and rejection cases.
- Date-only rows remain efficiently sortable by UTC anchor while retaining their lower precision and source-local calendar meaning.
- Spending chronology, account reconciliation, and statement liability can use occurred/effective, posted/accounting, and Statement dates respectively without conflating them.
- Conflicting conversion evidence remains inspectable without inventing fees or rewriting the booked amount.

## Rejected alternatives

- Copy a signed provider amount: sign conventions differ and liability accounts make balance-effect interpretations ambiguous.
- Allow `direction = unknown` in canonical transactions: Integration ambiguity would leak into every financial computation instead of being rejected at projection time.
- Infer currency from the account default: a Financial Account may contain multiple denominations.
- Use binary floating point or universal cents: neither preserves all source amount, rate, investment, or non-ISO denomination precision.
- Keep only one transaction date or use billing date as a transaction date: occurrence, settlement, accounting, and statement lifecycles answer different questions.
- Treat a date-only UTC midnight anchor as exact time: the anchor is storage normalization, not source-reported precision.
