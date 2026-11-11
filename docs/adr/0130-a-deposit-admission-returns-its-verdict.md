# A deposit admission returns its verdict

Status: accepted

Refines [ADR 0121](0121-deposit-sources-stage-through-one-step-that-runs-their-admission.md) and [ADR 0125](0125-a-deposit-commits-its-own-source-evidence.md). Holds [ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md): a refused admission still throws inside `product.validate`.

## Context

After ADR 0125, CTBC, HNCB, Post, Yuanta, SinoPac and Fubon each admitted a capture's financial facts in the ledger and returned `{ status, capture, diagnostics }`, where `capture` was null unless the status was `admitted`. Each workflow's `admitDeposit` callback then turned that result into a deposit decision by hand. The rules that decide between a deposit and a source-only commit were split between the two layers:

- **No rows.** CTBC and SinoPac committed source evidence alone when every response or download had no rows. The workflow checked this before it called the admission.
- **Source-only diagnostics.** HNCB, Yuanta and Fubon exported a predicate that named the diagnostics a capture may be downgraded for. The workflow filtered with it and built the source evidence.
- **Fubon's partial admission.** When every diagnostic was `row-status-unresolved`, the workflow ran the admission again with an `allowSourceOnlyRows` flag. It kept the second result only when it admitted at least one record.
- **Unreachable states.** HNCB, Yuanta and Fubon threw "admission lost its canonical capture" for an admitted result with no capture, which no admission produced. Each of the five canonical modules declared a `…DomesticDepositFinancialAdmissionError` that nothing threw.

The Fubon admission module also imported `FubonDepositStatementEvidence` from `src/workflows/fubon-statements.ts`, so the ledger depended on a workflow.

## Decision

**A deposit source's financial admission returns a `DepositVerdict`, and it throws `DepositAdmissionRefused` for a capture it may commit neither way.**

- `src/ledger/canonical/deposit-verdict.ts` defines both. A verdict holds exactly one of `capture` or `sourceOnly`. The refusal carries the diagnostics that refused the capture, and its message is `<source> financial admission failed: <diagnostics>`, the message each workflow threw before.
- The six admissions keep their names: `admitCtbcDomesticDepositFinancialCapture`, `admitHncbDomesticDepositFinancialCapture`, `admitPostDomesticDepositFinancialCapture`, `admitYuantaDomesticDepositFinancialCapture`, `admitFubonDomesticDepositFinancialCapture`, and SinoPac's `buildSinopacDomesticDepositFinancialCaptureForPGlite` and `buildSinopacForeignCurrencyFinancialCaptureForPGlite`. Each one that can return source evidence takes its capture id as `sourceCaptureId`.
- Every rule listed in the context now runs inside the admission. The source-only diagnostic predicates are private, and `allowSourceOnlyRows` is no longer part of Fubon's input.
- Post has no source-only capture, so its admission returns only the capture arm of the verdict.
- SinoPac's foreign-currency builder does not run `admitCanonicalFinancialDepositCapture`, so its verdict carries a `CanonicalFinancialDepositCapture`. The other admissions carry the validated capture.
- `DepositDecision` is a verdict plus the product label, and on the capture arm only, the balance capture and relation commands. A callback spreads the verdict into its decision.
- The workflow keeps what needs browser, network or ledger reads, or reports run progress. That includes Fubon's account-identity continuity, its ambiguous-identity and evidence-level source-only decisions and its statement exclusions, Yuanta's row counts and counterparty evidence, every first-stage evidence admission, and the progress events between stages.
- `FubonDepositStatementEvidence`, with its account, page, row and pagination-ambiguity types, moves into `src/ledger/canonical/fubon-domestic-deposit-admission.ts`. The workflow imports them from there.

## Considered options

- **Keep the status result and share one translator in the workflow.** Rejected. The translator would still need each source's predicate, and the no-rows rules and Fubon's retry would stay outside the ledger.
- **Carry the diagnostics on the source-only arm.** Rejected. The step stages only the source evidence, and no caller reads why a capture went source-only.
- **Move SinoPac's admission into `src/ledger/canonical/`.** Deferred. Its builders stay in `src/ledger/pglite/` and return the same verdict.

## Consequences

- The deposit commit goldens are unchanged, including the refusal message that `post-unknown-direction-rejected` pins.
- A direct caller of an admission now gets the source's rules. A SinoPac capture with no rows is source-only instead of an empty financial capture. A Fubon capture blocked only by unresolved rows is admitted with its posted rows. The `zero-result-authority-unproven` checks in SinoPac's financial builders are removed, because the no-rows rule runs before them.
- Checks that asserted an admission's status or diagnostics assert the verdict or the refusal's diagnostics instead. New checks pin CTBC's and SinoPac's no-rows rule and both outcomes of Fubon's partial admission.
- `src/ledger/canonical/` no longer imports from `src/workflows/` for Fubon.
- A new deposit source writes one admission that returns a verdict, and its callback spreads it.
