# One ledger module installs every financial store

Status: accepted

Builds on [ADR 0085](0085-opening-a-store-installs-newly-registered-contracts.md) and [ADR 0087](0087-manual-assets-live-outside-financial-accounts.md). Carries out the consequence of [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md) that the pages can be checked against a PGlite reader without the worker.

The order in which a store's tables are installed lived only in the desktop view worker: the canonical ledger, then the operational, Maicoin, preview and Manual Asset tables. Checks rebuilt their own subsets of that order, and thirteen files installed the preview or Manual Asset tables by hand. Because some of those partial stores had no Manual Asset tables, a `manualAssets` flag ("whether the store holds the Manual Asset tables") ran through the registry and three page scopes. Only the worker set it, and always to `true`. Most checks of what a Financial page contains ran through the Electron registry, its live extension and the settings file, because only there was a store complete.

**`installFinancialStore` in `src/ledger/pglite/store-layout.ts` installs every financial store.** It applies each schema in order and returns the store. Every step verifies its manifest and is safe to repeat, so the worker calls it on each launch. The test template's `full` shape is built by the same function.

**Every store holds the Manual Asset tables, and every page reads them.** The `manualAssets` flag is removed from the registry, `FinancialPageScope`, `OutsideScope` and the Spending page. A check that reads a page opens a `full` store.

**A page's content is checked in the ledger.** `financial-pages.check.ts` and `spending-page.check.ts` read the pages directly from a `full` store. The Electron checks keep what only the registry does: live republication, reading the Preview features setting at each read, the Spending page action, and dispatch.

## Considered options

- **Keep the flag and default it to `true`.** Rejected. The flag would still exist only for partial test stores, and a page could still skip Manual Assets by accident.
- **Move the worker's install order into an Electron helper.** Rejected. The ledger owns the schemas and their order; checks in `src/` could not use it without importing Electron.
- **Leave page checks in Electron.** Rejected. Each needed the registry, the live extension and an environment variable to check what one function returns.

## Consequences

- A new schema is added to `installFinancialStore` and appears in the worker and in the `full` test store together.
- A check that reads a Financial page uses `createTestPGlite("full")`. The narrower template shapes remain for checks that do not read pages.
- A store without the Manual Asset tables is no longer a supported shape.
