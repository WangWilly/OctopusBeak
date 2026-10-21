# Domestic deposit admission and commit submissions

Status: proposed

## Decision

Six bank deposit workflows (CTBC, Post, HNCB, Yuanta, Fubon, and SinoPac domestic) admit their captures through one shared [Domestic Deposit Admission](../../CONTEXT.md). Each bank contributes a Deposit Source Adapter covering row decoding, account identity and account-number evidence, Identity Epoch derivation, completeness proof, source-only diagnostics, and the current-balance match. Every workflow, including credit-card, loan, investment, and E-Invoice, hands typed Commit Submissions to `WorkflowFinancialCommitPort.submit()`. The commit side, not the workflow, chooses the PGlite command, which submissions share one atomic step list, and their order, so `PGLITE_CANONICAL_*_COMMAND` is no longer exported to workflows.

[ADR 0025](0025-canonical-financial-commit-execution.md) called for one execution module as the provider persistence seam, but `canonical-financial-commit-execution.ts` was never built. Under PGlite the seam became `PGliteWorkflowRunItem.command`, a raw serializable command that workflows assemble themselves. This decision puts that seam behind typed submissions, without changing ADR 0025's per-item atomicity, run statuses, or relation sequencing.

Before this decision, the six banks each held 750 to 2,100 lines repeating one stage sequence and the same generic helpers. Each used its own source-only fallback list and its own rule for matching a current balance to an admitted account. A fix to one bank's identity or validation did not reach the others.

## Considered options

- **Run admission inside the commit, in the App process, and pass only decoded rows across the worker seam.** Rejected for now. This would validate each capture once instead of twice, but it moves every bank adapter into the App process and moves admission failures out of the workflow's validation stage. Admission stays a pure function in the worker. `pglite/deposit.ts` keeps revalidating at the seam, because the admission brand cannot cross serialization.
- **Fold Cathay and LINE Bank into the same adapter interface.** Rejected. Cathay validates a lossless-JSON sync input, and LINE Bank admits through preflight evidence and its v13 human-attested contract. Fitting either one would widen the adapter interface for all six banks. Each may join later through its own decision.
- **Let the admission module emit stage events, unifying the event codes across workflows.** Deferred. The two orchestrations (inline workflows, and `collectSelectedProducts` for Yuanta and Fubon) emit different codes, which runtime suffix regexes and the dashboard consume. Unifying them is a separate change, so the admission module returns results and emits nothing.
- **Wrap commands in builder functions and keep `execute(items)`.** Rejected. A builder that only renames the command shape fails the deletion test, and the old seam would stay open to every caller.

## Consequences

- Behavior is frozen. Golden snapshots of each bank's commit output are recorded before the refactor and must not change. Identity, fingerprint, and Identity Epoch formulas stay byte-identical per bank ([ADR 0035](0035-source-contract-catalog-and-rule-admission.md)). A shared helper replaces a bank's copy only where the golden snapshot proves the outputs are identical.
- Relation follow-through is out of scope. Submissions carry the existing relation commands through unchanged ([ADR 0016](0016-evidence-gated-loan-repayment-relations.md), [ADR 0020](0020-shared-financial-admission-and-relation-follow-through.md)).
- Each bank module keeps its file name but exports only its adapter, plus the constants that the route registry and attestation need.
