# The MAX commit carries row type, state and TWD valuation

Status: accepted

Amends [ADR 0145](./0145-a-max-twd-transfer-names-its-one-matching-bank-row.md) and [ADR 0146](./0146-max-rewards-and-outside-crypto-deposits-count-as-income.md).

MaiCoin (MAX) was the only source whose figures bypassed canonical admission. The MAX adapter collapses deposit, reward, convert and wallet transfer into one `corporate_action_in` or `corporate_action_out`. ADR 0145 and ADR 0146 recovered the lost row type, MAX's `state` and a TWD value from an operational side table, `maicoin_statement_rows`, joined by source record key. That had these consequences:

- The workflow committed first and wrote the log afterwards. The relation resolve ran inside the commit's request, before the log had the new rows, so a new TWD deposit or withdrawal never matched its bank row in the sync that first saw it. A cancel or a crash between the two writes left canonical rows with no log row.
- The TWD value was a JavaScript float stored as `DOUBLE PRECISION`. The price it used was stored nowhere. A missing daily candle silently borrowed another day's close, and a transient price failure overwrote a good value with none.
- The log kept raw provider payloads, which PRODUCT.md rules out. Two of its three tables had no reader. Every sync rewrote up to 1000 rows even when nothing changed, and no cleanup covered them.
- The adapter ignored `state`, so a deposit that failed at MAX was a posted `corporate_action_in`.

## Decision

**One Canonical Financial Commit carries everything.** The three `maicoin_*` tables, the MaiCoin persistence port and its `maicoin.*` RPC operations are deleted.

**Where each fact lives:**

- The MAX statement transaction's source record payload gains `rowType` (`deposit`, `withdrawal`, `reward`, `convert`, `transfer` or `trade`), `state` (MAX's string, or null) and, when known, `twdValuation`. The route `maicoin/investment/canonical-v1` declares all three as revisable payload fields (ADR 0055). `rowType` is revisable too, because every occurrence admitted before this decision has a payload without it.
- The posting of the financial fact follows `state` through one closed table in the MAX adapter. MAX's v3 API gives a deposit, a withdrawal and an internal transfer one of four states: `processing`, `failed`, `canceled` and `done`. The source is the type definitions of MAX's own Node SDK, `maicoin/max-exchange-api-node`; MAX's API reference page serves its specification only to a browser. No state, or `done`, is posted and normal. `failed` and `canceled` are posted and canceled. Every other string, including one MAX adds later, is pending and normal, so an unknown state is never counted. A change of state writes the next transaction revision.
- `investment_transactions.row_type` holds the row type. It is set for MAX and null for every other source. A null on a MAX row means the row was admitted before the column existed; the next commit of that event fills it.
- `investment_transaction_twd_valuations` holds one valuation per event, written once. If a later capture carries a different valuation for the same event, the stored one stands and the commit still succeeds: a conflict there would stop every later MAX sync over an estimate. It records the exact value in TWD, the price route (`twd`, `direct`, `via-usdt`), the market, the exact daily close of each market it used, the candle's UTC day, and the capture, commit and source record that admitted it.

The MAX record key digests the endpoint, wallet type, row type, provider ID and leg only, and its collision key is derived from the record key alone. A change of state or valuation therefore keeps the occurrence, and continuation under ADR 0055 can never re-key it. A check asserts this, as ADR 0117 did for Fubon loan.

**Pricing keeps the store from growing on re-sync.** An unchanged re-sync reuses its stored source records (ADR 0152) and writes nothing.

- The sync prices only what ADR 0146 reads: a reward, and a deposit in a currency other than TWD.
- It prices only from a finished UTC day's candle. A row of the capture's own UTC day carries no valuation yet and stays unresolved in Cash flow until a later sync. A valuation is then fixed once written, so a row's payload changes at most once for its valuation.
- A price lookup has three outcomes. It finds the close. It finds no price, which is deterministic: the coin has no market, or MAX has no candle for that exact day, and another day's candle is never used. Or it fails, through a network error, a 5xx, a rate limit or a malformed response. A failed lookup fails the collection, which the workflow reports as `source-rejected`, so nothing is written and the next run retries. It is never recorded as no price, because that would flip the payload and store a new source record each time.
- The value is computed with exact decimals from the statement's quantity and the candle's close. Cash flow still rounds it half-up to two decimals at read time.

**Readers.** The MAX TWD transfer resolution (ADR 0145) selects MAX movements by `row_type IN ('deposit', 'withdrawal')`. Cash flow income (ADR 0146) reads `row_type` and the valuation table, and relies on the counted-revision filter in place of `state`: a deposit counts only when its current revision is posted, normal and active. Unique-only matching, the own-transfer rule and the unresolved bucket do not change.

**Migration.** One operational migration step backfills from the log when it exists. Each logged statement gives its row type to the investment row of each of its legs: `from` and `to` for a convert or a wallet transfer, `transaction` for every other row. A logged reward, and a non-TWD deposit logged as `done`, with a non-negative value, gives a `legacy-log` valuation that has no price, cites the row's existing source record, and is replaced by the first priced valuation a later sync carries. The same transaction drops the three tables and the `maicoin-operational-v1` record. A store that never synced MAX has nothing to backfill. A crash rolls the whole step back, and the next open runs it again.

Old revisions are not rewritten. A previously admitted deposit that MAX never completed is corrected by the next sync through an ordinary revision.

## Considered options

- **Keep the log and write it before the commit.** Rejected. The two writes still are not one transaction, and the log still holds raw payloads and repeated rows.
- **Keep the log's float value and add the price beside it.** Rejected. The value would stay inexact, and the log would keep growing on every sync.
- **Price every row type.** Rejected. Nothing reads a value for a trade, a convert or a withdrawal, and each extra lookup is one more way a sync can fail.
- **Price today's row from the live ticker and correct it later.** Rejected. The payload would change twice for one valuation, and every correction would store a new source record.
- **Record a failed lookup as no price.** Rejected. The next successful lookup flips the payload back, so the store grows by one source record per flip.
- **Keep a `legacy-log` valuation forever.** Rejected. Its value is a float product with no recorded price; the first priced valuation replaces it once, and it is the only valuation that can change.

## Consequences

- A new TWD deposit or withdrawal matches its bank row in the sync that first admits it, because the relation resolve reads the row type the commit just wrote.
- A deposit MAX has not completed is pending, and one that failed or was canceled is canceled. Neither counts in Cash flow, in the TWD transfer match, or as income.
- The first sync after upgrade stores one new source record for every MAX statement occurrence, because each payload gains `rowType` and `state`. Later unchanged syncs store none. A row's payload changes again only when MAX changes its state, or once when its day closes and it gains a valuation.
- A reward or crypto deposit of today stays unresolved in Cash flow until a sync after its UTC day ends.
- A MAX outage of the public candle endpoint fails the whole sync, where it used to leave values empty.
- ADR 0146's consequence that a later sync which cannot price an old statement replaces its value with none no longer holds: a written valuation is never removed.
- A MAX state outside the closed table counts as pending until the table names it. `done` is the only success state MAX's SDK lists, so a row is left uncounted this way only if MAX adds a state later.
