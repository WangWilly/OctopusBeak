# Only an answered cancellation is a cancellation

Status: accepted

Refines [ADR 0056](./0056-commit-attempt-is-the-authority-for-commit-outcome.md).

ADR 0056 settles a Commit attempt only from a verifiable result, and leaves it unsettled when the transport lost an item. Two places broke that rule once a cancellation had been requested:

- The workflow run classified every failure as `cancelled` as soon as its signal was aborted, including a socket that closed under the request.
- The RPC server answered `cancelled` for every failure of a request it had been asked to cancel, including a database worker that closed.

The call layer underneath already knew better. It keeps a cancelled call pending until the worker answers, because a commit may have crossed the cancel frame, and it treats a disconnected peer as indeterminate. The two layers above discarded that, so a commit that landed just before its transport died was recorded as a cancelled attempt, with a committed count that left it out.

## Decision

A request is cancelled only when the worker answers that it was. A request that lost its peer stays a fatal failure, whether or not a cancellation was requested meanwhile.

- The workflow run treats `closed`, `connection-failed` and `worker-closed`, and a worker failure of the `fatal` category, as a lost outcome before it looks at its signal.
- The RPC server answers `cancelled` for a cancelled request unless the failure is `worker-closed`. That one keeps its `fatal` category and its diagnostic.

A lost outcome is a fatal item, so the Commit attempt stays unsettled and the run reports commit outcome unknown, as ADR 0056 requires.

## Considered options

- **Classify by the error alone and ignore the signal.** Rejected. A store that rolls back under a cancellation throws its own error types, and the server would have to recognize each one to answer `cancelled`.

## Consequences

- A quit or a worker crash that coincides with a cancelled commit now ends the run as commit outcome unknown and marks financial data stale, where it used to end as cancelled.
- A cancellation the worker confirms is unchanged.
