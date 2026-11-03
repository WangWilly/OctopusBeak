# A live view publishes one value

Status: accepted

Narrows the transport of [ADR 0030](0030-pglite-owned-live-financial-views.md). Keeps [ADR 0079](0079-a-financial-page-owns-its-live-view-lifecycle.md), [ADR 0088](0088-live-view-dependencies-are-injected-watches.md) and [ADR 0090](0090-every-bridge-channel-is-declared-once-in-preload.md).

ADR 0030 let the view worker send either complete `live.query()` results or `live.changes()` diffs, so every hop between the worker and the renderer carried a list of rows. No view ever sent rows. Each of the four Financial page views publishes one page value. The worker wrapped that value as `[value]`, six hops passed the list along, and the renderer unwrapped it and treated any other length as an error. The rows-shaped generic path, `system.health` with its shared SQL views, served only checks.

**A live view publishes one complete value per publication.** The worker port, the IPC event, the preload `dataViews` bridge and the renderer stores all carry `value`, not `rows`. The IPC channel is `data-views:value`.

**The Financial page live views are the worker's only view source.** The worker receives a factory for its view source, because the Financial page live views need the database and clock that the worker creates. Production passes the Financial page live views. The lifecycle and protocol checks pass a fake value source. `system.health`, `defineLiveView`, `workerViewSource` and `createSharedLiveViews` are gone.

**Each side of the process seam keeps one cache.** The worker's cache shares one recompute among subscriptions to the same view and parameters. The renderer's view stores share one IPC subscription per key. The Financial page owns its store creation directly.

## Considered options

- **Strip the wrapping only at the two ends.** Rejected. The middle hops would still promise a list of rows that never comes.
- **Keep `system.health` as a probe that needs no ledger.** Rejected. A fake view source tests the worker's lifecycle without a production view nobody reads.

## Consequences

- A view that needs incremental changes adds its own message kind for diffs. It does not bring back a rows-shaped transport for every view.
- The worker's cache replays its last value to a new subscriber. With one window, a Financial page restart tears down the worker entry and reads again, as ADR 0079 requires. A second window that subscribes to the same view must make a restart bypass that replay first.
