# Refused Commit attempts and one run outcome decision

Status: accepted

Refines [ADR 0056](0056-commit-attempt-is-the-authority-for-commit-outcome.md) and [ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md).

## Context

A run's Collection scope version is checked again before each canonical write. If the person changed a Statement Selection, enablement, or identity after the run started, the PGlite host refuses the write before it opens a transaction. Nothing is written.

The refusal travelled back as a fatal RPC failure. The commit port could not tell it from a lost request, so it left the Commit attempt unsettled and threw `CommitOutcomeUnknownError`. After the run, execution noticed the refused scope and rewrote the run's error code, and any product's `commit-outcome-unknown`, to `collection-scope-changed`. That rewrite also hid a genuine commit outcome unknown from another product of the same run.

ADR 0056 put the run's commit outcome on one interpreter on the host. In practice four places decided a run's outcome: execution folded its own copy of the attempts through `commitAwareErrorCode`, the CAPTCHA coordinator called the finalization decision to ask whether a round succeeded, finalization applied stop precedence, and startup recovery applied its own copy of the unknown-commit rule. The runner's error path finished a run that threw as `workflow-failed` without consulting its attempts, so an execution that failed after starting a commit lost the unknown outcome.

## Decision

**A refusal is a known outcome.** The PGlite host reports a refused write with the `refused` failure category. The workflow run stops at the refused item, because the refusal holds for the rest of the run. The commit port settles the attempt as `refused` with the receipts committed before it. Product collection stops later products and names the product `collection-scope-changed`. Operational baseline 5 admits `refused` as a settled outcome. The post-run rewrite is removed.

**The Active Automation Task Run decides the outcome.** The owner keeps every Commit attempt it records, across every CAPTCHA round of the run. A settlement counts even if storing it fails, because the commit already ran; a start counts only once it is stored, because the worker commits only after that. The owner's one decision applies, in order:

1. An unsettled attempt makes the run commit outcome unknown, over every stop.
2. A force-quit, a cancellation, then a shutdown.
3. A refused attempt makes the run collection scope changed.
4. A failure code the worker proved.
5. A failed attempt.
6. A failure classified from the run's events.

Execution reports what it observed and whether the worker proved its failure code. It never reports commit outcome unknown; the report type excludes that code. The CAPTCHA coordinator asks the owner to assess a round's report instead of deciding. Startup and shutdown recovery apply the same decision to stored attempts with a shutdown stop.

## Considered options

- **Keep the post-run rewrite and make it skip runs with another unsettled attempt.** Rejected. The refusal would still be recorded as an unknown commit, and the rewrite would remain a second interpreter of commit outcome.
- **Throw a typed refusal error from the commit port.** Rejected. A returned refusal settles its attempt like a returned item failure; a thrown one would need a second settle path.
- **Keep `commitAwareErrorCode` in execution and pass its result to the owner.** Rejected. The runner's error path and the coordinator would still decide without the attempts, which is how the lost unknown outcome happened.

## Consequences

- A run's outcome has one implementation, tested through `openActiveTaskRun` and `finalizeOrphanedRuns`.
- An operational baseline-4 database is upgraded in place to baseline 5 on open.
- The financial RPC diagnostic for a refused write records `collection-scope-changed` instead of `workflow-failed`.
