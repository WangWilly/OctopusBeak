# Shared financial admission and relation follow-through

Status: accepted

Financial capture workflows share one admission module for capture assembly, common validation, and the atomic [Canonical Financial Commit](../specs/canonical-financial-storage.md). Loan and investment adapters retain their domain-specific financial rules and source translation. After a capture is durable, relation follow-through runs once when the required counterparty evidence is available, using retained canonical history; its resolution judgment remains a separate commit as required by [ADR 0016](./0016-evidence-gated-loan-repayment-relations.md).

## Decision

Capture success is determined by the shared admission and commit. A relation-resolution failure therefore does not fail collection: admitted facts and existing relations remain visible, while the failure is reported as a separate warning. The next relevant capture or an explicit rerun retries resolution from retained history; the first version does not add a background retry scheduler.

This deepens the admission seam without changing the canonical schema, projection ownership, or financial meaning established by [ADR 0010](./0010-canonical-financial-store-and-projection-boundary.md), [ADR 0017](./0017-canonical-schema-lifecycle.md), and [ADR 0018](./0018-canonical-projection-runtime.md). Relation follow-through remains asynchronous to workflow runs and append-only, preserving prior support when a later resolution is incomplete or fails.

## Consequences

- Shared capture behavior has one interface test surface for assembly, common validation, and atomic persistence.
- Loan and investment changes remain local to their adapters unless they alter shared admission rules.
- A capture can complete while relation resolution is pending or warning; callers must represent those outcomes separately.
- Retained history is the retry source, so a later relevant capture or explicit rerun can resolve relations across independent captures without making a workflow run the relation boundary.
