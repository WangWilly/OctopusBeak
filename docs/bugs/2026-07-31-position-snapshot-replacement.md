# Imported position snapshots retained closed positions

- Date: 2026-07-31
- Status: Fixed
- Affected projections: `brokerage_holdings`, `fund_holdings`

## Symptom

After importing a newer Yuanta brokerage holdings export, symbols that were present
only in an older export still appeared in Assets. The same accumulation behavior
also applied to redeemed fund holdings.

## Root cause

Imported holding rows are intentionally immutable and deduplicated across source
files. The account projection selected the latest row for each symbol, which
mistook the union of all historical holding rows for the current portfolio.
Absence from a newer full holdings export therefore had no effect.

## Fix

Brokerage and fund holdings are now treated as complete-set snapshots:

1. Classify source files with the same typed CSV parser used by the importer.
2. Select the latest source import for each bank/product pair.
3. Use source-row lineage to project only statement rows represented by that
   source import.
4. Keep historical rows in the ledger for audit and daily history.

An empty brokerage export is authoritative only when the workflow verifies every
requested holding page and finds a parsed report structure. A missing page or
failed extraction emits no holdings snapshot and preserves the previous one.

## Audit of other position-producing structures

| Structure | Semantics | Why the same bug does or does not apply |
| --- | --- | --- |
| Brokerage holdings | Complete-set snapshot | Fixed by latest source-import scope. |
| Fund holdings | Complete-set snapshot | Fixed by the same projection and covered by a redeemed-fund regression. |
| Credit-card balance | Verified capture | Already selects only complete captures with both billed and unbilled evidence; legacy or partial captures are excluded. |
| MaiCoin balance | Time-stamped account snapshot | Already selects the latest sync and explicitly creates zero-value positions for wallets absent from that latest sync. |
| TWD and foreign cash | Balance-bearing transaction stream | Current value comes from the latest transaction balance per account/currency; file-row absence is not a close-position signal. |
| Loans | Balance-bearing transaction stream | Current liability comes from the latest principal/balance row; file-row absence is not a payoff signal. |

## Verification

- A newer brokerage snapshot removes symbols omitted from the new full export.
- A verified empty brokerage snapshot clears the account.
- A newer fund snapshot removes redeemed funds.
- An empty Yuanta extraction without report structure is rejected.
- Existing credit-card capture and MaiCoin latest-sync regression coverage remains
  part of the full test suite.
