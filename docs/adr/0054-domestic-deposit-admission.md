# Domestic deposit admission

Status: proposed

## Decision

Six bank deposit workflows (CTBC, Post, HNCB, Yuanta, Fubon, and SinoPac domestic) admit their captures through one shared [Domestic Deposit Admission](../../CONTEXT.md). Each bank contributes a Deposit Source Adapter covering row decoding, account identity and account-number evidence, Identity Epoch derivation, completeness proof, source-only diagnostics, and the current-balance match. The admission returns the items the workflow hands to the Canonical Financial Commit, including the choice between a mixed source-and-deposit commit and a single deposit commit, so that choice is made in one place.

Before this decision, the six banks each held 750 to 2,100 lines repeating one stage sequence and the same generic helpers. Each used its own source-only fallback list and its own rule for matching a current balance to an admitted account. A fix to one bank's identity or validation did not reach the others.

## Considered options

- **Run admission inside the commit, in the App process, and pass only decoded rows across the worker seam.** Rejected for now. This would validate each capture once instead of twice, but it moves every bank adapter into the App process and moves admission failures out of the workflow's validation stage. Admission stays a pure function in the worker. `pglite/deposit.ts` keeps revalidating at the seam, because the admission brand cannot cross serialization.
- **Fold Cathay and LINE Bank into the same adapter interface.** Rejected. Cathay validates a lossless-JSON sync input, and LINE Bank admits through preflight evidence and its v13 human-attested contract. Fitting either one would widen the adapter interface for all six banks. Each may join later through its own decision.
- **Let the admission module emit stage events, unifying the event codes across workflows.** Deferred. The two orchestrations (inline workflows, and `collectSelectedProducts` for Yuanta and Fubon) emit different codes, which runtime suffix regexes and the dashboard consume. Unifying them is a separate change, so the admission module returns results and emits nothing.
- **Typed commit submissions in place of the PGlite commands every workflow builds, with the commit choosing the command, the atomic grouping, and the order.** Rejected after reading the commit side. The commit cannot choose the grouping: Cathay deliberately commits all of one run's domestic statements as one atomic item, and only the workflow knows that. It cannot choose the command either: a mixed commit with one step is not equivalent to that step's own command, because the direct commit turns a database error into a typed admission error that the run records as an item failure, while the mixed commit lets it propagate as a fatal run failure. Every other kind maps one-to-one to its command, so the submission type would only rename the commands across twenty workflows, and deleting it would remove no complexity. The useful part, which deposit captures commit with their source evidence, belongs to Domestic Deposit Admission.

## Consequences

- Behavior is frozen. Golden checks under `src/workflows/deposit-commit-goldens/` record each bank's commit items and progress events before the refactor, and they must not change. Identity, fingerprint, and Identity Epoch formulas stay byte-identical per bank ([ADR 0035](0035-source-contract-catalog-and-rule-admission.md)). A shared helper replaces a bank's copy only where the goldens prove the outputs are identical.
- Relation follow-through is unchanged ([ADR 0016](0016-evidence-gated-loan-repayment-relations.md), [ADR 0020](0020-shared-financial-admission-and-relation-follow-through.md)).
- Workflows outside the six banks keep building PGlite commands directly.
- Each bank module keeps its file name but exports only its adapter, plus the constants that the route registry and attestation need.
