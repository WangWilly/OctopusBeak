# One host assembles the ledger's shared parts

Status: accepted; the Spending page actions it names are Financial page actions since [ADR 0136](0136-spending-and-cash-flow-share-one-set-of-financial-page-actions.md)

Refines [ADR 0105](0105-spending-page-actions-publish-through-the-ledger.md) on how the registry and the live views come to hold the same Spending page actions. Builds on [ADR 0102](0102-one-ledger-module-installs-every-financial-store.md), which gave every caller one way to install a financial store.

## Context

ADR 0105 had the view worker build the Spending page actions once and hand them to the registry and to the live views as two separate arguments. The registry's argument was optional: a registry built without page actions ran its own. Only the worker composed all four shared parts (the registry, its page actions, the live views and the scheduler), inline among the database open, WAL checkpoints and RPC servers.

The live-view checks composed those parts by hand. Most built a registry without page actions and handed the views a separate set that refused every action, so the registry ran one set of page actions while the views watched another. No check that read live pages used the composition the worker serves.

## Decision

**`createPGliteLedgerHost` in `electron/pglite-ledger-host.ts` assembles the shared parts.** Given a live-capable PGlite, the financial store installed on it, a local-date clock, and optional readers for Preview visibility and the Overview's expected sources, it returns:

- the registry,
- the Spending page actions the registry runs,
- the live views, as the worker's view source,
- the scheduler that financial calls and view recomputes share.

The view worker opens the database, installs the store, and serves the host. A check that needs the composition the worker serves builds the host.

**The registry requires its page actions and exposes them.** `createPGliteFinancialRegistry(store, spendingPageActions, options)` has no fallback, and the registry carries the actions as `spendingPageActions`. A caller with no live views passes `createPGliteSpendingPageActions(store)`.

**The live views read the page actions from the registry.** `createPGliteFinancialLiveViews(registry, dependencies, expectedSources, scheduler)` takes no separate page actions, so a view and its registry cannot be given different ones. A check that fakes the live dependencies still builds views directly. When it needs page actions that refuse or that it settles by hand, it builds the registry with them.

**WAL checkpoints, the operational provider and the RPC servers stay in the worker.** They serve the worker's port and its database's lifetime, not the financial pages. A check of the pages has no port, and must not checkpoint a database it discards. The host only uses the scheduler that the worker's checkpoints run on.

## Considered options

- **Keep page actions a separate live-view argument and check the pairing in review.** Rejected. The checks had already drifted, and nothing failed when they did.
- **Let the host also install the store.** Rejected. The worker cleans up a database that fails to open or install before anything else holds it. The host starts from a store that is already installed.
- **Reach the page actions only through the registry, with no host member.** Rejected. The worker check and the host check name the actions the views watch. `host.spendingPageActions` is the registry's own instance, so it adds no second source.

ADR 0105 rejected one required `spendingPageActions` member on the registry, because the views would reach the actions through it. This ADR accepts that coupling. A view already reads its page from the registry, and taking the actions from the same place is what keeps the two from drifting.

## Consequences

- Production behaviour does not change. The worker builds the same parts; the live views are now built before WAL checkpoints start rather than after, which does no work until a view is subscribed.
- A registry-only caller, such as a workflow check or the demo seed, states its page actions in one call.
- A check that reads live pages over a real database builds the host, so it gets the worker's scheduler and page actions.
- A caller can still build a registry over one store and hand the views live dependencies over a different database. The host takes both from its caller, as the worker opens them.
