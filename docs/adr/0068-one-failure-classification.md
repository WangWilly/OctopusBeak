# One Failure classification names every Failure code

Status: accepted

Sits below the outcome precedence of [ADR 0058](0058-refused-commit-attempts-and-one-run-outcome-decision.md) and keeps its split between a failure code the worker proved and one classified from the run's events. Uses the Run event signals of [ADR 0059](0059-run-event-outcome-and-signal.md).

## Context

Three modules turn a thrown error and run events into a Failure code, and they disagree:

- The Product collection run names a product's code with `defaultFatalCode`, `typedProductFailureCode` and `failedStageCode`. It checks a stopped run first and treats `CaptchaProviderRejectedError` as run-ending at once.
- The worker runtime calls `classifyTypedWorkflowFailure`. It puts every other error class before a stopped run, and puts `CaptchaProviderRejectedError` after the stop and after `verification-solver-exhausted`.
- The host's `workerFailure` checks `solver-route-unavailable` itself, then calls the same classifier a second time with the execution's events.

TDCC maps its own errors through `classifyFatal` and `classifyFailure` hooks that only the Product collection run reads. TDCC signs in lazily inside product collection, so today its errors reach the hooks. Any other reader of a `TdccError`, such as the run-level classifier or a check harness, names it from its stage alone, so an untrusted device would become `authentication-failed` instead of `device-registration-required`.

## Decision

**One Failure classification module names every Failure code.** The Product collection run, the worker runtime and the host execution report all call it, each passing only the evidence it holds. Naming still happens in both processes, because a thrown error exists only in the worker.

**The order is fixed.** The first match wins:

1. A verification configuration signal (`solver-route-unavailable`, `solver-challenge-unsupported`). Only the host sees these, so the tier never matches in the worker and, in the host, outranks the worker's code.
2. A thrown typed error, `CaptchaProviderRejectedError` included.
3. A stopped run, giving `cancelled`.
4. The remaining Run event signals.
5. A failed `decoding` or `validation` stage.
6. The last operating stage other than `finalization`.
7. Otherwise `workflow-failed`.

Whether a stop outranks a failure stays the Active automation task run's decision (ADR 0058). So when a cancellation coincides with, for example, `SourceUnavailableError`, the product is named `source-unavailable` and the run is still cancelled.

**Whether a code ends the run is a fact of the code.** It sits in the Failure code table in `workflow-failures.ts`, beside the user action. The Product collection run reads it instead of keeping its own list of run-ending errors.

**Sources name their errors at their own seam.** `FailureCodeError` carries a Failure code from wherever it is thrown. Each TDCC error class extends it: `TdccError` derives its code from its failure reason and endpoint, and the TDCC contract, device-registration and summary-invariant errors carry theirs. The `classifyFatal` and `classifyFailure` hooks are deleted.

**The host keeps deciding `proven`.** `execution-outcome` still applies ADR 0058's rule for a worker code, and still never reports `commit-outcome-unknown`. A worker that ended cancelled reported no failure to classify, so its report stays `cancelled` whatever signals the host recorded.

## Considered options

- **Send raw evidence from the worker and name the code once on the host.** Rejected. The worker protocol would need a serialized error kind, and ADR 0058's proven worker code would lose its meaning, only to remove one call site.
- **Keep a per-source hook as an input to the classification.** Rejected. Any caller that forgets to pass it names a TDCC error from its stage alone.
- **Let the classification return whether the run ends.** Rejected. No code is run-ending in one place and product-local in another, so the fact belongs to the code.
- **Name a stopped run before any thrown error.** Rejected. A typed error is direct evidence of what failed, and ADR 0058 already ranks the stop above it when deciding the run.

## Consequences

- One table-driven check proves the order. `product-collection.check.ts` checks only run-ending versus product-local behaviour through the handle, and `execution-outcome.check.ts` checks only `proven`.
- Adding a typed error, or a code that ends the run, is a change in one module.
- A product cancelled while a typed error is in flight now shows that error's code instead of `cancelled`.
