# Run event outcome and signal

Status: accepted

Deepens tier 6 of [ADR 0058](0058-refused-commit-attempts-and-one-run-outcome-decision.md), "a failure classified from the run's events".

## Context

An Automation run event carried a closed `stage` and a free `code` string. Workflows emitted 91 distinct stage and code pairs. Five readers recovered the meaning of an event from the code's suffix, and each kept its own pattern:

- Workflow run progress treated `failed|rejected|cancelled|canceled|interrupted|error` as terminal.
- The run stage track treated `failed|rejected|exhausted|unavailable|unsupported|interrupted` as a failure.
- Failure classification read `rejected|failed|malformed` on decoding and `rejected|failed` on validation.
- The retry catch-up read `authentication-(completed|verified|success)`.
- The task row view and failure classification matched five exact codes.

`solver-challenge-unsupported` was a failure on the stage track and not terminal for progress. A workflow had to pick a code with the right suffix before it threw, or its failure was classified as something else.

## Decision

**A run event states its meaning.** Every event carries a Run event outcome: `started`, `advanced`, `completed` or `failed`. `completed` means the stage finished for the event's scope: the run, or one statement type. A sub-item that finishes inside a stage, such as one account, is `advanced`. There is no `rejected` outcome, because no reader tells it apart from `failed`. There is no `cancelled` outcome, because the run status already says a run was cancelled.

**A few events carry a signal.** A Run event signal names an event that a reader needs by name: `verification-solver-exhausted`, `solver-route-unavailable`, `solver-challenge-unsupported`, `login-dialog-interrupted` and `human-assistance-failed`. Each signal fixes its stage and outcome, so a workflow emits it with `context.signalEvent(name)` and cannot pair it with another stage.

**Readers use the outcome and the signal, never the code.** The code stays as a sanitized diagnostic the dashboard shows. One exception is declared, not conventional: an External prerequisite names the exact code its workflow emits when the prerequisite is missing, and run finalization looks that code up.

**Boundaries validate; readers trust the type.** The operational store, the worker protocol and the page model reject an event whose outcome or signal is outside the closed sets, or whose signal disagrees with its stage and outcome.

**Stored events are upgraded once on read.** Events stored before this decision have no outcome. The operational store derives it from the code when it reads a run, using the union of the old failure suffixes, then the old completion suffixes, then `started`, and `advanced` for the rest. The upgrade is removed once no stored event predates this decision: run events are kept 30 days.

## Considered options

- **Close the code itself into a union of every code.** Rejected. The interface would be as wide as the 91 codes, and readers would still switch over many of them.
- **Keep the free code and map it to an outcome in one table.** Rejected. A new workflow could emit an unmapped code and nothing would stop it.
- **Separate `rejected` from `failed`.** Rejected until a reader needs the difference.

## Consequences

- `src/lib/automation/run-event.ts` owns the event type, the outcomes, the signals and the stored-event upgrade. It is tested through `run-event.check.ts`.
- `WorkflowContext.event` takes `(stage, outcome, code, counts?)`, and `WorkflowContext.signalEvent` takes a signal name.
- Progress no longer reaches the end of collection when the first account finishes. Workflow run progress stops at every failed event, including the solver events the stage track already showed as failed.
