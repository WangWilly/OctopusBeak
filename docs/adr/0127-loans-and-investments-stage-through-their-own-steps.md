# Loans and investments stage through their own steps

Status: accepted

Extends [ADR 0119](0119-credit-card-issuers-stage-through-one-step.md) and [ADR 0121](0121-deposit-sources-stage-through-one-step-that-runs-their-admission.md) to loan and investment sources. Holds [ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md) for every loan and investment source by structure. Keeps the evidence gate of [ADR 0016](0016-evidence-gated-loan-repayment-relations.md) and the counts of [ADR 0122](0122-the-product-collection-run-sums-each-collector-s-counts.md).

## Context

After ADR 0126, the last collectors that called `product.stage` by hand were Fubon loan, Yuanta loan, Yuanta fund and Yuanta trade. Each wrote its own staging tail, and the copies drifted:

- **Fubon loan.** No admission ran inside `product.validate`. Building the capture, checking its account-number evidence and checking terminal page evidence all threw as `source-collection-failed`. Items were keyed `<captureId>:<queryItem>`, although `TRANSACTION_DETAIL_QUERY` was the only query item the input accepted. Reading and building were interleaved per account, so no check could build from a read without a browser. The repayment-mandate relation command was written inline, with no counterparty evidence when the selector hid the full account.
- **Yuanta loan.** No admission ran inside `product.validate`. The selector's 14-digit account check ran eagerly outside it. The record the mandate is anchored to was resolved lazily inside the relation thunk, against `occurrenceIndex`. That index counts within a group of identical rows, so any capture with two distinct rows had two candidates, the thunk threw, and the run recorded `relation-failed` for the loan.
- **Yuanta fund.** The history proof, the admission evaluation and `admitCanonicalInvestmentCapture` ran outside `product.validate`. The investment commit and relation commands were written inline.
- **Yuanta trade.** The admission already ran inside `product.validate`, but the commit and relation commands were written inline, and each account's `observedAt` came from `new Date()` instead of the run clock.

## Decision

**Loans stage through `src/workflows/canonical-loan-staging.ts`, and investments stage through `src/workflows/canonical-investment-staging.ts`. Each step has the deposit step's two-function shape.**

- `admitLoan(product, admit)` runs one capture's admission inside `product.validate` and returns a branded `LoanAdmission`. The decision carries the capture, the Source Connection key and integration namespace the relations resolve under, and an optional repayment mandate: the account, the record it is anchored to, the source field and the contract version.
- `stageCanonicalLoans(product, admissions)` accepts only branded admissions. It keys each item by its capture id and builds the `financial.loan.commit` command and the `financial.loanRelations.resolve` command. The step binds the mandate to the capture's identity and scope, and it holds the constants both banks share: role `beneficiary`, purpose `loan_repayment`, scope `loan_contract`, evidence kind `repayment-mandate`. A decision with no mandate resolves with no counterparty evidence, and the loan still commits.
- `admitInvestments(product, admit)` runs a source's whole-run investment admission inside `product.validate` and returns a branded admission. The admission keeps any counts the source computed beside its captures, so Yuanta trade still reports its ADR 0122 counts. `stageCanonicalInvestments(product, admission)` keys each capture by its id and builds the investment commit and its relation command from the capture's Source Connection key and observed instant.
- Both stage functions check the abort signal and call `stage` once.
- Each source keeps its own admission loop, its progress events and its abort checks between accounts. Browser, network and ledger reads stay outside `admit`. Capture grain is unchanged: a loan per account, a fund capture per effective date, a trade capture per account.
- Fubon loan splits into `readFubonLoanSource` and `stageFubonLoan`, as Yuanta loan already was ([ADR 0065](0065-product-runners-read-the-source-before-they-stage.md)).
- Yuanta's mandate checks run in its admission: the selector must expose the full 14-digit account, and the mandate is anchored to the capture's first source row by `sourceSequenceIndex`.

## Considered options

- **One generic core for loans and investments.** Rejected. The shared part is about ten lines: run `validate`, key by capture id, check the signal, stage once. Everything else is domain-specific. Loans admit per capture and build a mandate relation from optional evidence. Investments admit per run, carry the source's counts, and resolve relations with no evidence. A generic core would need a callback for each of those, so the domain step would still be written, only one layer further away.
- **One missing-evidence policy for both banks.** Rejected. Fubon's selector may mask the account, and that is not a failure: the loan commits without a mandate. Yuanta's selector value is the account itself, and a selector that does not expose all 14 digits is an identity failure, not a relation choice. The step takes an optional mandate, and each bank decides when to supply one.

## Consequences

- Admissions that ran outside `validate` and now fail as `source-validation-failed` instead of `source-collection-failed`:
  - Fubon loan: the terminal page evidence check in stage, the capture build and the account-number evidence check. `a Fubon loan statement without terminal page evidence fails inside the product's validation` proves it.
  - Yuanta loan: the terminal page evidence check, the capture build, the account-number evidence check, the 14-digit selector account check and the mandate anchor. `a Yuanta loan whose selector hides the full account fails inside the product's validation` proves it.
  - Yuanta fund: the history proof, the admission evaluation, the holding and transaction build, and `admitCanonicalInvestmentCapture`. The `yuanta-fund-statements` check proves it with a position whose transaction number matches no holding.
  - Yuanta trade is unchanged; its admission already ran inside `validate`.
- Yuanta loan mandates are now admitted for captures with more than one distinct row. Before, they failed in the relation thunk. Yuanta's relation request drops the unused `rowOrdinal: 0` field, which evidence admission ignores. Its fields are otherwise equal to before. The Fubon and investment relation commands are byte-identical to before.
- Fubon loan items are keyed by the bare capture id. Item keys label staging and receipts only and are not persisted (ADR 0121).
- Fubon loan's `queryItem` and `queryItems` inputs and their query item enum are removed. An account that offers no transaction detail query is still skipped. A run where every account is skipped is still reported as absent.
- Yuanta trade captures are observed at `context.now()`.
- Fubon and Yuanta loan commit goldens are recorded in `src/workflows/loan-commit-goldens/`. They drive `stageFubonLoan` and `stageYuantaLoan` from a read snapshot, without a browser. `UPDATE_LOAN_GOLDENS=1` rewrites them.
- No bank collector calls `product.stage` by hand; TDCC still does. A new loan or investment source writes only its admission.
