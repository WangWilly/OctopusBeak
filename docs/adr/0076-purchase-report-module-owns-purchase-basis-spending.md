# The Purchase report module owns purchase-basis spending

Status: accepted

Applies [ADR 0024](0024-purchase-basis-spending-and-report-deduplication.md), [ADR 0038](0038-invoice-item-categories-and-purchase-category.md) and [ADR 0042](0042-tdcc-admission-direct-source-precedence-and-passbook-movements.md) within the budgets of [ADR 0028](0028-interaction-and-pairing-performance-contract.md).

The rules of purchase-basis spending existed in four renditions. The record builder `composePurchaseReport` (TypeScript) built the complete and historical reports, the record page records, the candidate page records and the records a Pairing returns. `purchaseRowsCte` (SQL) selected the rows for the summary, the record page keyset, the month facts and the category rows. A set of targeted report patches in `spending-query.ts` and `spending-command.ts` rebuilt one linked or standalone record by hand after a decision, partly from totals the renderer sent. The page action computed its summary delta from a third set of hand-built lines, `summaryLine`, `summaryLineFromRecord` and `standaloneSummaryLines`.

The renditions disagreed:

- **A delta dated a card payment by its posting date.** `standaloneSummaryLines` dated the bank-only line by the payment's effective date, while the summary buckets it by consume date, then posting date, then effective date. Confirming a card payment consumed and posted on different days moved the wrong day, or failed on a day that had no records.
- **Refunds.** The SQL counted only an active refund with an amount and an occurrence, and never one of a transaction Direct source precedence covers. The builder let any refund it was given replace its transaction's bank-only record, and emitted a refund record for a covered transaction.
- **Record shape.** The complete report attached pending candidates to linked records and left their payment source empty; the record page did neither.
- **Money.** The builder kept each total at its widest scale and the currency as stored; the summary reduced the scale; only the category totals upper-cased the currency.
- **The record page dropped rows silently.** A row the SQL selected but the builder did not produce was left out of the page.

The targeted patches, the `{patch}` action result and the report snapshot caches served only the renderer path for a report without a summary. Production always loads the summary page, so that path never ran; it was removed first.

**`src/ledger/pglite/purchase-report.ts` is the one interface for purchase-basis spending.**

- **It owns both renditions of the purchase rows.** `purchaseRowsCte` stays SQL for every read ADR 0028 budgets: the summary, the record page keyset, the month facts and the category rows. The record builder stays a pure function in `spending-purchase-report-core.ts`, and every caller reaches it through the module: `queryCurrentSpending`, `queryHistoricalSpending`, `queryCurrentSpendingRecordPage`, `purchaseRecordsByIdentity` (record page, candidate page and action records) and `decide`.
- **`decide(transaction, pair, write)` applies a Pairing decision.** Inside the caller's write transaction it reads the pair's records with the builder, runs the command's write, reads them again, and returns the records after and the summary delta between the two reads. A record built the same way on both sides cancels, so a denial has an empty delta. `applyPGliteSpendingPageAction` uses it, and the `SpendingPageActionResult` contract to the renderer and the live view is unchanged.
- **One refund rule.** Only an active refund recognition with a non-null amount and occurrence counts, and only for a transaction Direct source precedence does not cover. A counted refund adds its refund record and replaces its transaction's bank-only record; any other refund leaves that record standing. `countedPurchaseRefunds` applies the rule in the builder and `active_refunds` applies it in SQL. We took the SQL rule because ADR 0024 makes a withdrawn source record cease to support spending, and ADR 0042 excludes a covered account from spending; the builder rule let a withdrawn or covered refund still remove a purchase.
- **One record shape.** A linked record never carries pending candidates and is never a possible duplicate, as on the record page that production shows. A record with a transaction carries its payment source, and the complete report now loads payment sources too. Card and statement facts are not versioned by knowledge point, so a historical record's payment source names only its institution.
- **One money rule.** Every purchase total goes through `addPurchaseMoney` and `purchaseMoneyTotals`: the currency is upper-cased and the total is reduced to canonical scale. The summary SQL groups by the upper-cased currency and reduces each row the same way. The summary keeps `totalStatus: "complete"` with its candidates `unloaded`; that is the lazy-loading signal for the candidate page, not a claim about candidates.
- **The record page fails instead of dropping a row.** Both renditions now apply the same rules in one read transaction, so a selected row the builder cannot produce is a defect. The read throws. A read has no side effects and the summary still renders, so an error the person can retry is safer than a page that lists fewer records than the summary counts.
- **One identity helper.** `spending-sql.ts` holds the query wrapper, `latest`, `bytes`, `idString` and the UUID patterns that the query and command modules duplicated. Each takes the stricter behaviour: `bytes` requires a non-empty string, `idString` throws on text that is not a UUID instead of passing it through, and `latest` rejects a version that is not a non-negative safe integer.
- **Canonical fact readers move to `spending-facts.ts`.** Transactions, invoices, recognition, item categorizations and payment sources are read there, so `purchase-report.ts` and `spending-query.ts` both use them without importing each other.

## Considered options

- **Keep the SQL and the builder, and test their equivalence.** Rejected. The checks compared outputs after the fact; the refund disagreement passed them because no fixture held a withdrawn or covered refund.
- **Move every read to SQL.** Rejected. The records carry invoice items, categorizations, recognition and payment sources; building them in SQL would duplicate the Purchase category reading of ADR 0038.
- **Move every read to the builder.** Rejected. The summary and the record page keyset cannot meet ADR 0028's budgets by composing 100k records.
- **Take the builder's refund rule.** Rejected. It counted a refund the source had withdrawn and a refund of a covered account, against ADR 0024 and ADR 0042.
- **Drop a missing record from the page and log it.** Rejected. The page would disagree with the summary without telling anyone.

## Consequences

- A card payment's Pairing delta now moves its consume date, so the patched summary equals the recomputed one.
- The complete and historical reports no longer show a refund of a covered transaction, and their totals no longer subtract it. The summary already excluded it, so the totals the Spending page shows do not change.
- The builder no longer lets a withdrawn or amount-less refund replace a bank-only record. The PGlite recognition read already returned only active refunds, so stored data reads the same; a caller that hands the builder other refunds now gets the bank-only record back.
- Linked records in the complete report lose the pending candidate ids they used to carry, and records with a transaction gain a payment source. Totals keep their amounts but may come back at a smaller scale, for example `10` at scale 0 instead of `1000` at scale 2.
- A Pairing reads the pair's records twice instead of once, still inside the one-second Pairing budget. `npm run check:pglite-spending-performance` and the Pairing UI performance check time `pageAction`.
