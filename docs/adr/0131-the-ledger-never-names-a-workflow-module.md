# The ledger never names a workflow module

Status: accepted

Takes up the ledger direction that [ADR 0114](0114-a-check-keeps-main-only-code-out-of-the-renderer.md) deferred.

## Context

ADR 0114 deferred direction rules for `src/ledger` and `src/workflows` because a rule would start with a list of exceptions. Most of those exceptions are now gone:

- [ADR 0130](0130-a-deposit-admission-returns-its-verdict.md) moved Fubon's statement evidence types into the Fubon deposit admission.
- LINE Bank's evidence types and source timestamp parser moved into its ledger admission, which removed a runtime import cycle.

Four check files still imported workflow code:

- `src/ledger/pglite/loan.check.ts` used `buildFubonLoanPaymentAccountEvidence` from the Fubon workflow.
- Three E.SUN credit-card checks under `src/ledger/pglite/` built captures with the E.SUN workflow's builders.

## Decision

**`scripts/dependency-direction.check.mjs` adds a third rule, with no exceptions: no module under `src/ledger`, checks and fixtures included, names a module under `src/workflows`.**

The rule counts every specifier, including `import type`, `export … from`, `import()` and `import("…")` types. A type import counts because it is the coupling the rule guards against: the ledger owns the shape of what it admits, and a workflow builds that shape.

To meet the rule:

- `buildFubonLoanPaymentAccountEvidence` and its contract version moved into the Fubon deposit admission. It derives counterparty evidence from statement evidence the ledger already owns.
- The three E.SUN checks moved to `src/workflows/`, because they drive the workflow's capture builders through the PGlite commit.

## Considered options

- **Exempt check files.** Rejected. A check that reaches into a workflow from the ledger tree gives the next change a precedent, and the move costs nothing.
- **Rules for `src/lib` ↔ `src/ledger` and workflows ↔ automation.** Still deferred. Those directions are not separated yet.

## Consequences

- A ledger change that needs a workflow's type or helper must move it into the ledger first.
- A check that exercises a workflow builder together with the ledger lives under `src/workflows/`.
