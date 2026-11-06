# A failed snapshot check names itself in the failure diagnostic

Status: accepted

Extends the sanitized failure record of [ADR 0081](0081-error-reports-sent-by-hand.md) for the checks of [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md) and [ADR 0108](0108-a-broken-credit-card-current-snapshot-fails-the-card-capture.md).

## Context

A current-state snapshot that fails its checks reports only `source-validation-rejected`. The failure diagnostic keeps error types and stack frames but never a message, so it cannot say which check rejected the source. In development the diagnostic is not even written unless `OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE` is set.

When Fubon started serving its current-credit page at `?menuId=CCC0201&`, the run reported a validation rejection and nothing else. Finding that the endpoint check had rejected the trailing separator took three live reruns with temporary logging.

## Decision

**Each snapshot check names itself.** The snapshot module throws `SnapshotCheckError` with one of a fixed set of checks:

| Check | Rejects |
|---|---|
| `response-endpoint` | an invalid URL, or a host, path or query outside the declaration |
| `response-method` | a method other than the declared one |
| `response-status` | a status other than 200 |
| `response-content-type` | a content type outside the declaration |
| `response-cache-control` | a missing declared Cache-Control directive |
| `response-date` | a missing required HTTP Date, or an invalid one |
| `evidence-json` | a JSON body that does not parse |
| `row-parse` | a plain error from the source's row parser |

The row parser's plain error becomes the `cause` of a `row-parse` error and keeps its message. An error with its own type, such as `SourceTextIntegrityError`, passes through unchanged, so its classification does not change.

**The diagnostic carries the check, not the message.** A node of the diagnostic error chain gains an optional `snapshotCheck`, read from the error and accepted only from the fixed set. This follows the existing `sqlState` and `httpStatus` fields.

**The Error report leaves it out for now.** The receiver accepts only `type`, `sqlState`, `httpStatus` and `frames` on a chain node, so the App drops `snapshotCheck` when it builds a report. A receiver change that accepts it comes first; a later App change then sends it.

**A development run writes the diagnostic by default.** `npm run desktop:dev` sets `OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE` to `/private/tmp/octopusbeak-workflow-failures.jsonl` unless the variable is already set. Setting it to an empty string turns the file off. A packaged App is unchanged.

## Considered options

- **Record the error message.** Rejected. Messages can quote source text, such as an amount or an account label, which ADR 0081 keeps out of every record.
- **Rely on stack frames.** Rejected as the only signal. Frames point into built chunks that change with every build, and a report drops frames outside `build-electron/`.
- **Put the check on the record instead of the error.** Rejected. The check would have to travel from the snapshot module to the product failure separately from the error that already carries it.
- **Show the check in the product outcome.** Deferred. The outcome is persisted with a strict schema, and the problem this solves is a developer's diagnosis.

## Consequences

- A rejected snapshot in a development run leaves a diagnostic line that names the check, for example `"snapshotCheck":"response-endpoint"`.
- Statement validation outside the snapshot module still reports without a check.
- The Error report payload is unchanged until the receiver accepts `snapshotCheck`.
