# A Financial page owns its live-view lifecycle

Status: accepted

Applies the renderer stores of [ADR 0030](0030-pglite-owned-live-financial-views.md) to the pages [ADR 0069](0069-ledger-composes-financial-pages-and-decides-net-position.md) composes.

The Overview, Assets, Liabilities and Spending pages read PGlite live views through one Svelte store per view key. Which view was subscribed, each page's load state, the live error banner and the reloads that wait for a fresh read lived in `src/routes/+page.svelte`, spread over about a dozen variables and five functions beside the hash parsing, onboarding and automation code. No test could reach that code; `root-shell.check.ts` pinned it with regular expressions. It had five defects:

- **Two reloads of one page.** A second reload replaced the first one's waiter and rejected it, so the refresh reported a failure and the page showed an error notice although the new subscription delivered.
- **A route change during a reload.** Leaving the page rejected the waiting reload, which `loadRoute` and the refresh coordinator reported as a failure.
- **A reload that did not re-read.** Automation keeps the Overview store subscribed for its `overviewLive` panel. Resubscribing that store replays its cached value synchronously, so the Overview reload resolved with the data it already had.
- **A global, sticky error.** One `financialLiveError` flag drove the banner, so a failed page left it showing on Automation and Settings.
- **A failed subscription was kept.** Showing the same page again did nothing; only the Retry button recovered it.

**`src/lib/financial/client/financial-page.ts` owns the live-view lifecycle of the Financial pages.** `createFinancialPage({ dataViews })` takes the data-view transport and returns:

- `state`: whether the capability is resolved and enabled, the route whose view is subscribed, and for each page its load state and its own live error.
- `show(route)`: subscribes that page's view and stops the previous one; `null` stops it. Showing the subscribed page again does nothing, unless its subscription failed: then it restarts.
- `reload(route)`: shows the page and restarts its view, and settles on the next page the view delivers. A second reload of a page that is already waiting returns the same promise. A reload or show of another page ends the waiting reload with `FinancialPageSuperseded`, which callers treat as a cancellation, not a failure. Without live views it rejects as before.
- `overviewStore()` for Automation, and `dispose()`.

The view-store registry gains `restart(view, params)`. It starts a new transport generation for a subscribed key, so every subscriber sees loading and then the new subscription's value, even while other consumers hold the store. Stale callbacks of the replaced generation are dropped as before. A reload always restarts.

`+page.svelte` keeps the hash parsing, the onboarding gate, the automation blocks, the refresh coordinator wiring and the rendering. It subscribes to `state`, calls `show` and `reload`, and shows the banner only for the current route's error.

## Considered options

- **Keep the lifecycle in `+page.svelte` and fix the five defects there.** Rejected. The fixes are timing rules that only a module test with a fake transport can pin; regular expressions over the page cannot.
- **Let the waiter skip a value replayed from the cache.** Rejected. A reload of unchanged data would never deliver a different value, so the waiter would never settle. Restarting the subscription is the only way to know a value is fresh.
- **Evict the cached store so a resubscription starts over.** Rejected. ADR 0030 shares one transport subscription per key among consumers; evicting it would start a second one for Automation's panel.

## Consequences

- A refresh while a reload of the same page is waiting succeeds once, with the new data.
- Leaving a page during its reload no longer shows an error notice or a failed refresh.
- An Overview reload during onboarding or first-run Welcome reads the Overview again, even while Automation shows its Overview panel. Every reload stops and starts the transport subscription for its view, including for the other consumers of that view.
- The live error banner shows only on the page whose subscription failed. Returning to that page restarts its subscription.
- The automation route's load state stays in `+page.svelte`.
