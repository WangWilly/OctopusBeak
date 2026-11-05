# Spending page actions reach the live page through one ledger module

Status: accepted

Extends [ADR 0089](0089-spending-page-composed-in-the-ledger-with-one-version.md), which moved the Spending page's composition out of the RPC registry. Keeps the one-value live views of [ADR 0093](0093-a-live-view-publishes-one-value.md) and the injected dependencies of [ADR 0088](0088-live-view-dependencies-are-injected-watches.md).

A Spending page action, such as confirming a pairing, returns its exact summary delta. The live Spending page takes that delta instead of reading the whole page again, and holds its recompute while actions run. That rule was split across three places:

- **The registry** counted running actions, kept the newest result among overlapping ones, and told listeners when the last one settled. It offered `isSpendingPageActionInFlight` and `onSpendingPageActionSettled` beside the RPC operations, typed as an optional mix-in that the live views imported back from the registry.
- **The Spending live view** held its recompute while an action ran. Once actions settled, it applied the delta to the published page, rebuilt the page's canonical view and purchase report by hand, and decided whether to read the page again. None of those branches had a check; the one related check faked the registry's two hooks.
- **The Spending model** computed the delta.

**`src/ledger/pglite/spending-page-actions.ts` owns the rule.**

- `createSpendingPageActions(apply)` runs the actions against one store and answers `inFlight()` and `onSettled(listener)`. When the last running action settles, each listener hears once, with the newest result among the actions that overlapped, or `null` when none succeeded.
- `spendingPageAfterAction(page, result)` applies the delta to a published page and says whether the page now shows the action.
- `spendingPageNeedsRecompute(page, version, settled)` decides whether the page is read again: the store moved past it, or the settled action never reached it.

**The worker builds the actions once.** It hands them to the registry, whose `financial.spending.pageAction` runs them, and to the live views, which receive `{ registry, pageActions }`. A registry built without them, as the workflow checks build it, runs its own. The registry no longer offers page-action hooks; its remaining mix-in carries only the preview-visibility event.

## Considered options

- **Keep the hooks on the registry, as one required `spendingPageActions` member.** Rejected. The registry routes financial RPCs, and a live view would still reach the actions through it.
- **Also move the renderer's handling of an action result.** Rejected. `PurchaseSpendingSession` applies the result to its own record list, selection and candidate page, which the worker never sees. It shares only the delta computation, which already lives in the Spending model.

## Consequences

- The publication rule is checked through the module with no registry or database: each reconcile outcome, a commit or Manual write during an action, overlapping actions, and listener failures.
- A page newer than a settled action is still read once more, as before.
- Every caller of `createPGliteFinancialLiveViews` passes the page actions. Views that never see an action pass actions that are never run.
