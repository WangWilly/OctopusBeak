# The Spending page is composed in the ledger, in one snapshot, with one version

Status: accepted

Extends [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md) to the Spending page. The purchase report of [ADR 0076](0076-purchase-report-module-owns-purchase-basis-spending.md) still owns the purchase-basis rows; Manual purchases ([ADR 0087](0087-manual-assets-live-outside-financial-accounts.md)) are layered on outside it.

Overview, Assets and Liabilities were composed in `src/ledger`, each in one transaction. Spending was composed in the RPC registry instead:

- **Two snapshots.** The registry read the canonical summary in one transaction and the Manual Asset revision and purchases in a second. A commit between them published a page whose parts came from different points, which the live view only repaired on its next recompute. ADR 0069 reads each of the other pages in one transaction.
- **Renderer code ran in the worker.** The merge of Manual purchases into the summary lived in `src/lib/spending`, but only the worker called it.
- **Two freshness values.** The Spending live view asked `financial.spending.version` for the canonical knowledge point and `financial.manualAssets.revision` for the Manual Asset revision, in two calls, and compared each against the published page in two places.
- **Two availability rules.** The merge kept the canonical availability when nothing was counted, while a page action's result derived it from the record count. They agree today only because the canonical summary is never `unavailable`.

**`src/ledger/pglite/spending-page.ts` composes the Spending page.** `readSpendingPage(reader, { manualAssets }, request)` reads the canonical summary and the Manual purchases with the caller's reader, and derives the canonical view with `spendingCanonicalAt`, the same rule a page action uses. The registry opens one transaction and dispatches to it.

**One version.** `financial.spending.version` returns `{ knowledgeAt, manualRevision }`, read in one transaction by `readSpendingPageVersion`. `spendingPageBehind(page, version)` decides whether a published page is older than the store, and both of the live view's checks use it. `financial.manualAssets.revision` is removed. Pairing, candidate pages and the pending overview keep comparing `knowledgeAt` alone, because Manual purchases never take part in them.

## Considered options

- **Keep two version calls and only share the comparison.** Rejected. The two values could still come from different points in time.
- **Combine the two values into one string.** Rejected. A string can only say equal or not equal; the live view must also tell whether a canonical version is newer than an action's.
- **Leave the composition in the registry and wrap both reads in one transaction there.** Rejected. The registry routes every financial RPC, and ADR 0069 moved page composition out of it for that reason.

## Consequences

- A Spending page's canonical and Manual parts always come from one snapshot.
- Adding something else the Spending page counts changes `spending-page.ts` and the version, not the registry or the live view.
- ADR 0069 says the ledger has no clock. That is no longer true: `FinancialPageScope.today` carries the person's date so an ended Manual Asset stops counting, and [ADR 0088](0088-live-view-dependencies-are-injected-watches.md) watches that date as a dependency.
