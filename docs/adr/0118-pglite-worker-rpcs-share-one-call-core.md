# PGlite worker RPCs share one call core

Status: accepted

Refines [ADR 0115](0115-a-crashed-pglite-worker-restarts-on-the-same-database.md) on the error an in-flight request receives.

Relates to [ADR 0072](0072-host-calls-go-through-one-contract-table.md), which kept the workflow host-call channel off the operational correlator.

## Context

The PGlite worker serves two request/response protocols on one MessagePort: the financial protocol (`pglite-financial-*` frames) and the operational protocol (`pglite-operational-*` frames). The workflow child reaches both through a newline-JSON socket that forwards the same frames. Each protocol had its own copy of the same machinery. Each client had a pending map, an id counter, ready gating, and close. Each server had an envelope validator, response posting, an active-call set, and close. Three identical port types and six byte-identical copies of `plainRecord` existed.

The copies had drifted:

- The operational client rejected with a plain `Error` on close and after close. The financial client rejected with a typed `worker-closed` error.
- The financial server refused a request that reused an active id. The operational server ran it a second time.
- The view worker client and its supervisor closed both clients with plain errors.

ADR 0072 rejected sharing a correlator between the workflow host-call channel and the operational protocol. Its reasons were that the operational protocol ignores uncorrelated responses, does not validate results, and has no lanes or stop behaviour. Those reasons apply to the host-call channel, whose contracts need all three. The two PGlite protocols both ignore uncorrelated responses, and neither validates results. Their differences are the contract table, the error vocabulary, lanes, and cancellation.

## Decision

**One module, `electron/pglite-worker-call.ts`, owns the call machinery. Both PGlite protocols are built on it. The wire format does not change.**

- The core exports `WorkerPort`, `plainRecord`, `createWorkerCallClient`, and `createWorkerCallServer`. The client half allocates ids, matches responses by id, ignores responses for unknown ids, gates sends on `ready`, sends a cancel frame when a caller's signal aborts, and rejects every pending call on close. The server half checks the request envelope, refuses calls after close and calls that reuse an active id, posts each response, and waits for active calls on close.
- Each protocol keeps its own frame kinds, versions, contract table, argument decoding, error class, and failure vocabulary. Only the financial protocol has lanes, latest-wins coalescing, commit admission, and cancellation. The core takes these as callbacks.
- The operational protocol has the same close and id rules as the financial one. A call pending at close, or made after close, rejects with `PGliteOperationalError("worker-closed")`. A request that reuses an active id is refused with `invalid-request`. Operational close waits for running calls and does not abort them, because the protocol has no cancellation.
- **Operational calls stay off the work scheduler.** The financial server runs every call through `PGliteWorkScheduler`, one at a time, interactive before background. The operational server runs each call when it arrives. Operational calls include automation run-state and run-event writes, preview writes, and MaiCoin batches. These must not queue behind background financial reads and coalesced recomputes. Revisit this only with a measurement that shows the interleaving costs more than the wait would.
- The view port (`src/lib/data-views/server/view-port.ts`) stays separate. It is subscription-shaped: one request opens a stream of values and errors that ends on stop. It does not fit request/response correlation. It also lives under `src/`, which does not import from `electron/`.

## Considered options

- **One protocol and one contract table for financial and operational calls.** Rejected. It changes the wire format, so the child socket's frame check and both peers must change in one release, and the gain over a shared core is one table.
- **Put operational calls on a scheduler lane.** Deferred. An operational lane would order operational writes against financial work. Without a measurement, the risk of delaying run-state writes behind a long background read is greater than the risk of interleaving.
- **Share the core with the workflow host-call channel.** Not adopted. ADR 0072's reasons still hold for that channel.

## Consequences

- A change to correlation, ready gating, or close is made once and applies to both protocols.
- A caller can tell a closed worker from other failures by error class and code on both protocols.
- When a ready view worker exits, or its client is closed, calls already sent reject with the typed `worker-closed` error, and the worker's own failure is the error's `cause`. This refines ADR 0115's "fails with the dead worker's error": the error is now typed and carries that failure. A call made before the worker became ready still rejects with the start failure itself, as before.
- A new request/response protocol on the worker port is a frame kind, a contract table, and a `start` callback.
