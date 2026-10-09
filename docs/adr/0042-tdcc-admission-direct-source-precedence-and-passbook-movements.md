# TDCC admission: direct source precedence and passbook movements

Status: accepted

## Decision

Phase 1 of [ADR 0041](0041-tdcc-epassbook-app-protocol-source.md) admits four TDCC e-Passbook products: securities holdings, fund holdings, settlement bank accounts with their transactions, and securities passbook movements. Statement selection offers three items: securities (holdings and passbook movements), funds, and settlement accounts. The TR087 asset trend is not collected, because the canonical store has no provider-reported time series and the daily history is computed from observations.

### Direct source precedence

TDCC reports accounts maintained by banks and brokers that may also have their own supported source, such as Cathay United Bank or Yuanta Trade. [ADR 0008](0008-source-scoped-lineage-and-strict-canonical-admission.md) keeps those identities separate, and the overview would count both. Direct source precedence resolves this for each Institution and product. While a direct source holds at least one current account for that Institution and product, every TDCC account there is covered. A covered account stays visible in its own account view, labelled with the direct source that counts it, and is excluded from totals, net worth, activity, and spending. Coverage is evaluated from data, not settings, so a direct source that is enabled but has never synced leaves TDCC counting.

This amends Source authority routing in CONTEXT.md. Overlapping routes still fail, except that a fixed precedence now decides between a direct source and an Intermediary source. No account numbers are compared and no identities merge, so this is not the user-selected or fuzzy reconciliation that ADR 0008 rejects.

### Institution mapping

Settlement accounts carry a 3-digit bank code, and broker accounts carry a broker branch code. A closed table maps every bank head-office code to its Institution and every broker branch code to its firm. An account whose code is not in the table is not admitted, and the run reports an unknown institution code for it. The other accounts proceed.

The table is generated from two registries by `scripts/generate-institution-tables.mjs`. Bank codes are the FISC (財金資訊) members that receive remittances into accounts, without the central bank, bills finance companies, and clearing centres. Broker codes are the TWSE head offices and branches. TWSE data shows that a firm's branches share its head-office code up to the trailing zeros, so `981a` belongs to `9800` and `1021` to `1020`. The generator fails if a branch matches no firm or more than one. A broker that only TPEx lists is unknown until the table includes it.

`src/lib/institutions/institutions.ts` is the one catalog that the ledger and the interface share. It holds each Institution's key, kind, and names. It also maps each integration namespace to a direct Institution or marks it as an Intermediary source. An Institution with a direct source keeps its existing key, such as `cathay`. Every other key derives from its registry code, such as `bank-004` or `broker-9A00`, so the key never depends on a translated name.

Each Financial Account records its Institution in a required `institution_key` column on `financial_accounts`. The store resolves it when it creates the account. A direct-source account takes the Institution of its namespace, and any Institution the capture supplies must equal it. An Intermediary-source account must carry an Institution from the capture's contract evidence, such as the TDCC bank code. A namespace that the catalog does not map cannot create an account. A later capture whose Institution differs from the stored one is rejected, because the Institution is part of what the account is. The column is written once and the change needs a rebuilt database, like every baseline change under [ADR 0035](0035-source-contract-catalog-and-rule-admission.md).

Two other placements were considered. Keeping the Institution only in account identity metadata, such as the source account key or capture evidence, needs no column, but every reader would parse the key or join through captures, and direct-source accounts would have no stored value to compare. A separate `account_institutions` table would hold only intermediary accounts, so readers would need two paths. The column gives every account one place for its Institution, which Direct source precedence can group on.

### Settlement accounts

Each settlement account is one Financial Account per bank code, account number, and currency, on the `tdcc` namespace and the `domestic-deposit` stream. `src/ledger/canonical/tdcc-settlement-admission.ts` turns TSP006 and TSP007 bodies into captures.

- TSP007 transactions form one complete-range capture per account. Every page must report `isComplete: true` and the same `startDate` and `endDate`, or the capture is rejected. The signed amount comes from `transferInAmount` or `transferOutAmount`, and exactly one of them must be non-zero. `balance` is the balance after the row.
- `txnDateTime`, `startDate`, `endDate`, and `updateTime` are read as Gregorian Asia/Taipei times, as the all-set-tw reference reads them. The 14-digit and 8-digit shapes would also fit an ROC `0YYY` year, so a year outside 1900 to 2099 rejects the capture instead of being misread.
- TSP007 has no reliable occurrence identifier. The reference client saw TDCC fill in `stan` after a row first appeared, so `stan` and `hcode` stay out of identity and content. Identical rows keep their multiplicity through occurrence groups ([ADR 0034](0034-workflow-semantic-occurrence-disambiguation.md)). Only the `hcode` values seen live, empty and `0`, are admitted.
- TSP006 gives one current-balance capture per account: `balanceAmt` is the ledger balance and `availableBalance` is the available balance, both effective at the response's `updateTime`.
- An account with an unknown bank code or a non-ISO currency, and every TSP006 time deposit, is reported as a typed exclusion rather than dropped.

### Passbook movements

TR002 rows are Passbook movements, not investment transactions. They change Security quantity and never create a cash fact, because TDCC reports no settlement amount and quantity times price omits fees and tax. The settlement account carries the cash. Code `113` maps to buy and `123` maps to sell. Any other code rejects the Capture for that broker account. Dates are ROC `0YYYMMDD` and are converted exactly.

- Each broker account is one Financial Account on the `tdcc` namespace and the `investment` stream, keyed by broker branch code and account number. Its Institution is the branch's firm from the catalog. An account whose branch code is not in the catalog is reported as a typed exclusion.
- One capture per broker account holds every TR002 page the client walked back to `D0002`. Its complete history range ends on the collection day in Asia/Taipei, because no later movement can exist yet, and starts at the oldest trade or posting date.
- A movement's identity is its `txnDate`, `postDate`, and `txnSerNo`. These are unique per account, so the route needs no occurrence groups. A repeated identity in one capture, or a recollected movement whose content changed, rejects the Capture.
- Quantity is slot 12, the trade date slot 9, and the posted date slot 0. The Security is slot 2, named by slot 3. Its type comes from slot 8 through a closed table (`00` equity, `12` mutual fund), and a symbol that starts with `00` is an ETF. Its currency is slot 20 and must be an ISO 4217 code.

Passbook movements are a separate list on the investment capture, `passbookMovements`, beside the cash-bearing `transactions`, and they are stored in their own `investment_passbook_movements` table. The movement type has no cash field, the table has no cash columns, and only `transactions` reach the financial-fact writer, so no path turns a movement into a cash fact. One rule, checked at admission and again at the commit boundary, keys on the catalog's direct or intermediary mark for the namespace. An Intermediary source may carry Passbook movements and no `transactions`. A direct source may carry `transactions`, each with its required cash, and no Passbook movements.

The other placement considered was an optional `cashEffect` on investment transactions, allowed when the route sets a quantity-only flag. It reuses one list and one table, but `investment_transactions` would gain nullable cash columns that every reader of activity and funding relations must handle. The type would also allow a direct-source row without cash, and only a runtime flag check would stop it. A separate list makes both mistakes impossible to express.

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

- `lastServerTime` and `updateTime` are Gregorian Asia/Taipei `YYYYMMDDhhmmss` times, read like TSP006 `updateTime`. The holding's effective date is the local date, with source-reported-as-of evidence that names the field.
- A securities holding's Security is item slot 0, named by slot 1, typed by slot 6 through the same table as TR002, and priced in the slot 19 currency, which must be an ISO 4217 code. A broker account repeating one Security rejects the Capture.
- Each fund account holds the funds of one sale organisation. Its Institution is the catalog bank (3-digit code) or broker (4-character code) for `saleOrgCode`, and any other code is reported as a typed exclusion with its holding count. A fund Security is `fundNo`, named by `fundCHName`. Its own pricing currency is not admitted, because only the TWD value is.
- Every TDCC investment account reports in TWD.

### Empty holding snapshots

The holdings projections treated a collection run of an account as the set of holding rows that share one `observed_at`. A run with no holdings wrote nothing, so the last Security an account sold stayed current. A holding capture may now declare that its holdings are the account's complete inventory at its effective date, with the source field that dates it. The store records each declaration in `investment_holding_snapshots`, and the overview and daily history count it as a collection run even when it holds nothing. Every TDCC holding capture declares one, so a broker account that holds nothing commits an empty snapshot. A fund account that TR051V1 no longer lists also holds nothing, so the caller passes every fund account it has already admitted and each absent one commits an empty snapshot. Yuanta Fund holdings come from the account-wide overview, so every Yuanta Fund holding capture declares one too. Its explicit position absence declares an empty snapshot only when the complete account history ends on the collection date, because a sale after an earlier query end would otherwise be dated too early. Captures from other sources do not declare snapshots, and their projections are unchanged.

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
- Securities admission gains a quantity-only path without cash. That path is limited to Passbook movements from an Intermediary source. The `investment_passbook_movements` and `investment_holding_snapshots` tables are baseline changes, so an existing database must be rebuilt.
- Holding valuations rest on an unverified slot until a live sample confirms it.
