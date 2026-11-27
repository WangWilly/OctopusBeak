# A source admission is gated like a commit

Status: accepted

Amends [ADR 0148](./0148-the-workflow-socket-serves-only-workflow-operations-and-refuses-unowned-commits.md).

ADR 0148 left `financial.source.admit` ungated, because "it validates evidence and writes nothing canonical." That is not what the operation does. It opens a transaction and stores a `canonical_commits` row, the source connection and its identity epoch when they are new, the authority route and its binding, the source capture and every source record. Product collection relies on that: a source-only capture, such as an account with no rows in the period or an identity that could not be proven, is admitted so the evidence of "nothing here" is kept.

So a workflow thread whose Collection scope had changed, or whose run had ended, could still create a source connection and captures under the old scope. [ADR 0058](./0058-refused-commit-attempts-and-one-run-outcome-decision.md) and ADR 0148 exist to prevent exactly that for every other canonical write.

## Decision

`financial.source.admit` is marked `workflow: "commit"`. The child socket refuses it, before it reaches the store, unless write admission answers `admitted`.

Nothing else changes. An admission already runs as an item of the workflow run, through the same request as a commit, so a refusal takes the existing path: the run stops at the refused item, the Commit attempt settles as `refused`, and the run reports that its Collection scope changed. The diagnostic keeps the `validation` stage.

## Considered options

- **Make the admission write nothing.** Rejected. Source-only evidence is stored on purpose, and a capture that left no record could not be traced.
- **A narrower gate that refuses only a run that is not current.** Rejected. That is the rule for relation resolution, which derives rows from evidence already admitted. An admission stores new evidence under the run's scope, as a commit does.

## Consequences

- A run whose scope changed can no longer store a source-only capture. Its product is reported as `collection-scope-changed`, as it would be for a commit.
- The sentence in ADR 0148 that lists `financial.source.admit` among the ungated financial calls no longer holds. The workflow surface check lists it with the commits.
