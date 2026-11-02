# Live-view dependencies are injected watches, and preview data has one revision

Status: accepted

Refines how the worker of [ADR 0030](0030-pglite-owned-live-financial-views.md) decides that a Financial page must be read again. [ADR 0079](0079-a-financial-page-owns-its-live-view-lifecycle.md) covers the renderer side and is unchanged.

`createPGliteFinancialLiveViews` hard-coded how each kind of change was watched inside one subscribe function: the canonical commit sequence, the exchange-rate rows, a fingerprint query over the preview tables plus the Preview features listener, the Manual Asset revision, and a 60-second date poll. That caused three defects:

- **Preview tables listed twice.** The fingerprint lived in `electron/` while the tables are defined in `src/ledger`. It drifted once already: Liabilities stopped refreshing on preview loans until the loan tables were added, and it still left out `preview_credit_cards`.
- **The date rode on Manual Assets.** The date poll ran only for views that declared `manual`, so Spending, which reads Manual purchases but no end dates, polled the date too.
- **Errors after the first value were dropped.** The worker adapter passed three of the four subscribe arguments, so a failed recompute, a failed date read, or a failed Spending watch never reached the renderer.

**Each dependency is a watch.** A dependency has one operation, `watch({ changed, failed })`. It resolves with a stop function once the dependency is ready. `changed` asks for a recompute, and `failed` reports an error to every listener of the view. The live-view core waits for every dependency, coalesces and serializes recomputes, and publishes. It does not know how any dependency watches.

**The worker composes the dependencies.** A view definition names what it reads besides canonical commits: `exchangeRates`, `preview`, `manual`, `today`. The worker passes a complete record of dependencies, so a missing one is a type error. A test passes fakes. The `manualAssets` option is gone.

**Preview data has one revision row.** `preview_data_revision` holds one counter, like `manual_asset_revision`. The preview port's `write` and `deleteAll` advance it in their transaction, so a new preview table needs no change to the live views. A Canonical Reset keeps the row; the reset's canonical commit already refreshes every view. The `preview` dependency combines that row with the Preview features listener, because visibility lives in settings, not in preview data.

**The date is its own dependency.** One clock per worker reads the business-timezone date every 60 seconds and reports only a change. The registry reads its `today` from the same clock. Overview, Assets and Liabilities declare `today`; Spending does not, because the renderer moves its month with the Taipei date.

## Considered options

- **Move the fingerprint query next to the preview tables.** Rejected. It keeps a hand-kept table list that every new preview product must extend.
- **A database trigger on every preview table.** Rejected. Every preview write already goes through `write` or `deleteAll`, so the trigger would only guard writers that do not exist.
- **An append-only preview commit log like `canonical_commits`.** Rejected. Canonical commits carry knowledge versions and commit attempts ([ADR 0056](0056-commit-attempt-is-the-authority-for-commit-outcome.md)). Nothing reads the history of preview writes; a view only needs to know that preview data changed.
- **Advance the preview revision when visibility changes.** Rejected. The revision would then move without any preview data changing.
- **Declarative dependency descriptors run by the core.** Rejected. The core would again hold each kind's watching logic.
- **Share one live query per dependency across views.** Deferred. Four pages is a small load, and the watch interface lets an adapter share later without changing the core.

## Consequences

- A new preview table or product refreshes the live views without touching `electron/`.
- Spending no longer polls the date.
- An error after a view's first value reaches the renderer's live error.
- The live-view core is tested with fake dependencies; each dependency is tested against PGlite or a fake clock.
