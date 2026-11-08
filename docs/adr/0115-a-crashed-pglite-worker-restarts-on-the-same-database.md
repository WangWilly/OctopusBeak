# A crashed PGlite worker restarts on the same database

Status: accepted

Keeps the single database owner of [ADR 0030](0030-pglite-owned-live-financial-views.md) and the live-view contract of [ADR 0079](0079-a-financial-page-owns-its-live-view-lifecycle.md).

## Context

The PGlite worker is a `worker_threads` thread in main. A WebAssembly trap, WebAssembly memory exhaustion and JS heap exhaustion each end only that worker, and main receives its `error` event. `process.abort()` is refused inside a worker. Main kept running in every case, so moving the worker to a `utilityProcess` would isolate only a crash in Node or V8 itself. It would also add a process hop to every page read and live-view update.

Recovery was missing, though. Once the worker died, `pglite-ipc` answered `worker-unavailable` to every renderer subscription, and the financial and operational ports rejected every request until the App was relaunched.

## Decision

**`electron/pglite-worker-supervisor.ts` keeps one client across workers.** `superviseWorker` presents the same `PGliteViewWorkerClient` that the runtime, the IPC bridge and the child RPC server already use.

- **Which deaths restart.** When a worker that had opened the database dies, a new worker opens the same data directory. A worker that never became ready is not restarted, because a database that fails to open fails again.
- **Requests.** A request in flight fails with the dead worker's error, which keeps today's behavior for a write whose outcome is unknown. A request sent after the restart waits for the new worker to become ready.
- **Live views.** Every live view subscribes again on the new worker with its view and parameters. The renderer keeps its subscription, and the new worker publishes the current value.
- **Restart limit.** After three restarts within a minute, the next crash is not restarted. It reaches `onError`, so the renderer sees `worker-unavailable` as it did before.

The operational provider is derived from the operation table by `operationalProviderOver`, the same function the RPC client uses. The supervisor therefore forwards every port method without a hand-written list.

## Considered options

- **Move the worker to `utilityProcess`.** Rejected. It isolates almost nothing PGlite can trigger and adds a process hop. The worker entry would also need to serve both Node checks and Electron.
- **Restart without a limit.** Rejected. A worker that crashes on every query would loop forever and hide the failure.
