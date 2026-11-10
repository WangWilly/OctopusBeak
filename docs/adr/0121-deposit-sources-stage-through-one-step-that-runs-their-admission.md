# Deposit sources stage through one step that runs their admission

Status: accepted

Extends [ADR 0119](0119-credit-card-issuers-stage-through-one-step.md) to deposit sources. Holds [ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md) and [ADR 0108](0108-a-broken-credit-card-current-snapshot-fails-the-card-capture.md) for every deposit source by structure.

## Context

SinoPac, HNCB, CTBC, Post, LINE Bank, Fubon, Yuanta and Yuanta foreign currency each wrote the same staging tail by hand: decide whether a capture is source-only or financial, build its command, match the current balances, check the abort signal, and stage everything once. The copies drifted:

- **Item keys.** SinoPac keyed items by position (`domestic-deposit:0`). LINE Bank keyed foreign-currency items by position, Yuanta foreign currency by account number, and CTBC by an occurrence id that differs from the capture id. The others keyed by capture id.
- **Abort check.** SinoPac, HNCB, CTBC and LINE Bank staged without checking the abort signal after the balance snapshot validated.
- **Validation.** Yuanta and Fubon ran their admissions outside `product.validate`, so an admission that threw failed as `source-collection-failed` instead of `source-validation-failed`.
- **Order.** HNCB, Yuanta and Fubon staged source-only items before deposits. SinoPac and CTBC staged them in account order.

## Decision

**`src/workflows/canonical-deposit-staging.ts` owns the staging tail for every deposit source, in two functions.**

- `admitDeposit(product, admit)` runs one capture's admission inside `product.validate` and returns a branded `DepositAdmission`. The decision says either "commit this source evidence alone" or "commit this deposit capture". A deposit decision may carry the capture the balance snapshot matches (LINE Bank's foreign-currency captures carry none), source evidence committed in the same transaction (the mixed command), and relation commands.
- `stageCanonicalDeposits(product, admissions, currentBalance)` accepts only branded admissions. It keys each item by its capture id, stages source-only items first, then deposits in admission order, then balances. It validates the balance snapshot before it checks the abort signal and calls `stage` once. With no balance capture to match, it neither reads nor stages the snapshot. The current balance is either acquired by the step, with the instant the source read it when that came earlier (LINE Bank), or passed as rows the source already read ([ADR 0065](0065-product-runners-read-the-source-before-they-stage.md)). The step returns the rows the snapshot's `exclude` policy left out, for the source to report (Fubon).
- Each source keeps its own admission loop, so its progress events, abort checks between accounts, and ledger reads (Fubon's account-identity continuity) stay where they are and outside `validate`.

The step is split in two, not one function that takes admission callbacks, because LINE Bank and CTBC report per-account progress events between admissions and Fubon admits some accounts only after reading the balance rows. The brand keeps the ADR 0106 guarantee that a single function would have given: a decision written without `admitDeposit` does not typecheck as an admission. The brand guards against forgetting `validate`, not against forging an admission on purpose, such as by spreading a real one with a different capture.

## Considered options

- **Unify the deposit command.** SinoPac and CTBC commit source evidence with the deposit in one mixed command; the others commit the deposit alone. Deferred: the step carries both through `withSource`, and choosing one needs its own look at what the ledger does with the source evidence.
- **Let a source name its own item key.** Rejected. Item keys label staging and receipts only and are not persisted, so deriving them from the capture id costs nothing and makes a positional key unrepresentable.

## Consequences

- SinoPac, CTBC, LINE Bank foreign currency and Yuanta foreign currency stage under new item keys. SinoPac and CTBC also stage source-only items before deposits. Their commit goldens change only in item keys and item order. A foreign-currency capture id ends in a content digest, so the gitleaks config allowlists it in commit goldens.
- Checks that ran outside `validate` and now fail as `source-validation-failed` instead of `source-collection-failed`:
  - Yuanta: the terminal-download check, the evidence and financial admissions, the lost-capture check, and the counterparty evidence admission.
  - Yuanta foreign currency: the capture admission.
  - Fubon: the evidence admission, the financial admission, and the lost-capture check.
  - HNCB: the lost-capture check.
  - SinoPac, HNCB, Fubon and Yuanta: building the source evidence, which cannot fail on well-formed captures.
- Success-path run events and the other sources' goldens are unchanged, because `validate` reports only failures.
- A new deposit source writes only its admission. Credit-card issuers move to the same shape in a follow-up change.
