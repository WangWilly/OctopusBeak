# Host calls go through one contract table

Status: accepted

Refines [ADR 0032](0032-app-owned-workflow-runtime.md). Applies [ADR 0056](0056-commit-attempt-is-the-authority-for-commit-outcome.md).

A workflow worker asks the host for six things: append a run event, record a Commit attempt, report exchange-rate progress, request Human assistance, lease or read the TDCC session, and save a rotated TDCC session. Each had its own frame kinds, hand-written validator, worker-side pending map, and host-side in-flight flag, ID set and counter, so adding one meant editing the protocol, the worker runtime, the supervisor and task-run execution together. Three requests shared one `event-ack` reply, and the exchange-rate request was allowed by comparing the workflow ID in two places.

**Every host call is declared once, in `HOST_CALL_CONTRACTS`.** `app-workflow-host-calls.ts` owns the table, the worker's `HostCallClient` and the host's `HostCallDispatcher`. The protocol keeps only the start frame, the lifecycle frames (`cancel`, `completed`, `failed`, `cancelled`) and two envelopes: `call {callId, method, request}` and `reply {callId, ok, result | code}`. The protocol version is 3.

- **A contract names its lane and its per-run cap.** Calls in one lane run one at a time: the client queues them, and the dispatcher treats an overlap as a protocol failure. Run events, exchange-rate progress and Commit attempts share the `acknowledged` lane, which keeps their order; Human assistance and the TDCC session have their own lanes.
- **A contract says what a stop does to it.** A `drop` call is abandoned: the host races it against the stop and does not answer, and the worker stops waiting. An `answer` call is not abandoned: the host is not raced, answers while the run stops, and the worker keeps waiting until the run ends. Only the Commit attempt is `answer`, which is ADR 0056's rule that a stop does not discard a settlement in flight.
- **Both sides validate.** The dispatcher parses each request and the client parses each result with the contract's validators, which are the hand-written ones the frames used. A call ID is a UUID and is used once per run. An invalid frame, an unknown method, a repeated call ID, a method the run has no handler for, a busy lane, a passed cap, an uncorrelated reply or an invalid result is a protocol failure.
- **A failed handler answers with its contract's failure code.** Acknowledgements answer `event-persistence-failed`, which the worker raises as before. A contract without a failure code, or a handler that throws `HostCallRefusal`, is a protocol failure; the host refuses a run event for another run this way.
- **A one-way call keeps only the newest value.** The rotated TDCC session is a notify contract: the dispatcher keeps the newest and writes it on the next turn or when the run ends, so the session survives a run that fails, is cancelled or crashes right after.
- **The host decides which calls a run may make by the handlers it passes.** Task-run execution passes the TDCC pair only when the definition requires TDCC, and the exchange-rate handler only when it reports exchange-rate progress.

## Considered options

- **Keep the frame kinds and move only validation and dispatch into a table.** Rejected. One reply kind would still answer three requests, and each new call would still need its own reply kind.
- **Share a correlator with `pglite-operational-rpc.ts`.** Rejected. That channel ignores uncorrelated responses, does not validate results, and has no lanes or stop behaviour; a shared module would need an option for each difference.
- **Add per-call timeouts or cancellation.** Not adopted. No host call needs one, and Human assistance waits for a person by design; a run is still cancelled as a whole.
- **Make exchange-rate progress a Workflow capability.** Rejected. A capability is a port the executor hands the workflow; exchange-rate progress is a dependency the registry injects into the definition, so the definition declares `reportsExchangeRateProgress` instead.
- **Migrate one call at a time with old and new frames side by side.** Not adopted. The old and new frames could not share a correlator, so the intermediate states added work without leaving `main` in either shape.

## Consequences

- A new host call is one contract and one handler. The runtime and supervisor do not change.
- Worker and host must run the same protocol version; both ship in one App build.
- Exchange-rate progress now has its own cap of 64 per run instead of sharing the run-event cap of 512.
- The worker still builds the exchange-rate sync service by workflow ID, because the registry needs it before the definition exists.
