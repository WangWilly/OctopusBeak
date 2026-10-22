# The Commit attempt is the authority for commit outcome

Status: accepted

## Decision

Before this decision, whether a run's Canonical Financial Commit happened was inferred from stage events that each workflow emitted by hand around `financialCommit.execute()`. The host, the worker, finalization, progress and the renderer's stage track each matched those event codes with suffix regexes such as `/commit-started$/`. Nine workflows and product collection wrote the codes, with three naming schemes. The same situation was classified differently by different workflows: MaiCoin reported a thrown request as a known `canonical-commit-failed`, while Post reported a returned `failed` result as `commit-outcome-unknown`. Renaming one code would silently turn an unknown outcome into an ordinary failure.

So the [Commit attempt](../../CONTEXT.md) recorded by the commit port is the only authority.

- **The port owns the record.** The `WorkflowFinancialCommitPort` adapter reports a started Commit attempt to the host before it calls the canonical worker and settles it afterward. Workflows never record or announce a commit themselves; `WorkflowContext.event` rejects the `commit` stage at compile time.
- **Returned means known.** A returned result is settled with its status: `completed`, `failed` (including `partially-completed`), or `cancelled`. A thrown request or a receipt that fails validation leaves the attempt unsettled. Execution items are independently transactional under [ADR 0025](0025-canonical-financial-commit-execution.md), so a returned `failed` result is a known outcome, not an uncertain one.
- **Durable before the request.** The host appends each attempt phase to the operational store through the Active Automation Task Run ([ADR 0052](0052-active-automation-task-run-owns-run-lifecycle.md)) before the port proceeds. A worker that dies mid-request leaves a started attempt with no settlement, which reads as commit outcome unknown without inference.
- **One interpreter, on the host.** The run's commit outcome is unknown if any attempt is unsettled, failed if any attempt failed, and otherwise follows the other precedence rules ADR 0052 defines. The worker sends raw attempts and does not classify them.
- **Events are derived.** The port emits the only commit stage events, with one fixed code set. Progress and the stage track compare codes by equality; nothing classifies outcomes from event codes.

## Considered options

- **A `commitStage()` helper workflows call instead of the port.** Rejected. Calling it remains a convention a new workflow can skip.
- **Move every workflow onto selected-product collection.** Rejected. Not every workflow is a selected-product run, and the change is far larger than the seam it fixes.
- **Typed commit events on the existing event stream.** Rejected. Outcome would still depend on the progress stream being complete, and run events are bounded diagnostics, not financial authority.
- **Keep attempts only in host memory.** Rejected. An App crash would lose them and send finalization back to inferring from events.

## Consequences

- Operational baseline 4 adds an append-only commit attempt table; a baseline-3 database is upgraded in place on open.
- Product-prefixed and `current-balance-` commit codes are removed. Product collection keeps per-product outcomes from the returned result and no longer validates receipts itself; the port does.
- Startup recovery still records rows left by a previous process as `interrupted`. Using an unsettled attempt to record such a row as commit outcome unknown is a separate change.
