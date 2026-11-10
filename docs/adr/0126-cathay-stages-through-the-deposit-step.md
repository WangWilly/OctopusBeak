# Cathay stages through the deposit step

Status: accepted

Refines [ADR 0121](0121-deposit-sources-stage-through-one-step-that-runs-their-admission.md) and [ADR 0125](0125-a-deposit-commits-its-own-source-evidence.md). Supersedes the Cathay grouping that [ADR 0054](0054-domestic-deposit-admission.md) gave as its reason to keep the mixed commit.

## Context

ADR 0121 moved seven deposit sources onto `src/workflows/canonical-deposit-staging.ts`. Cathay was the last deposit source outside the step. It still wrote its own staging tail:

- **Grouping.** Each product staged one `financial.mixed.commit` item keyed `statements:<runId>:domestic` or `statements:<runId>:foreign-currency`. The item held every account's capture as one step each.
- **Domestic command.** Domestic steps were legacy financial commit requests built by `src/ledger/pglite/cathay-domestic-adapter.ts`, not deposit captures.
- **Validation.** Both admissions ran outside `product.validate`. Foreign-currency captures were admitted twice, once in the runner and again to match current balances.
- **Order.** Statements were staged before the current-balance snapshot validated.

ADR 0054 kept the mixed commit because "Cathay deliberately commits all of one run's domestic statements as one atomic item". The grouping protected no cross-account invariant. Each step was an independent per-account capture with its own account, scope and records, and no check read two accounts together.

## Decision

**Cathay domestic and foreign-currency deposits stage through `admitDeposit` and `stageCanonicalDeposits`, one item per account keyed by its capture id.**

- Cathay's own loop admits each account inside `admitDeposit`, so an admission that throws fails as `source-validation-failed` (ADR 0106). Browser and network reads stay in collection. The loop keeps its `domestic-admission-*` and `foreign-admission-*` events.
- The collection keeps its completeness checks. A product with no account, or with fewer captures than the accounts it selected, still fails before any admission.
- Domestic admission produces a `CanonicalFinancialDepositCapture` on the existing `cathay/domestic-deposit/v1` route and commits with `financial.deposit.commit`. The admission and its adapter merge into `src/ledger/canonical/cathay-domestic-deposit-admission.ts`. The connection, identity epoch (`cathay-domestic-deposit-v1`), subject and occurrence key formulas are unchanged. The row payload names the accounting date `accountingDate`, so the deposit path checks it against the effective date.
- Each decision carries its capture as the balance capture. The step acquires the current-balance overview, validates it, checks the abort signal and stages once. Rows match the admitted deposit's identity: connection, epoch and stream must be shared, and the account key is `sourceAccountKey ?? accountNo`.
- `financial.mixed.commit` is removed. No source produces it.

## Considered options

- **Keep one mixed item per product.** Rejected. It gave Cathay a failure mode no other source has, a ledger error that fails the run, to protect an invariant that does not exist.
- **Keep the legacy financial request for domestic.** Rejected. It would leave the step needing a second command shape for one source, and the deposit path already validates the same route profile.

## Consequences

- A Cathay domestic or foreign-currency admission that throws now fails as `source-validation-failed`, not `source-collection-failed`. A broken current-balance snapshot now stages no deposit, because the step validates it before its single stage call.
- Item keys change from `statements:<runId>:<product>` to each capture's id, and the item count per product grows from one plus balances to one per account plus balances. Deposits stage before balances in one call. The Cathay commit golden changes in item keys and split, command kind, the domestic capture shape and payload key, and the staged item count in the validation event.
- A ledger conflict on one Cathay account now fails only that account's item. The run commits the other accounts, as every other deposit source already does.
- Domestic transactions are identified by the occurrence key, which the deposit path uses as `sourceSequence`, instead of Cathay's `sequenceNumber`. The renamed payload key also changes every occurrence key. **Existing Cathay domestic data must be reset after upgrading.** There is no migration, and the identity epoch stays `cathay-domestic-deposit-v1`.
- Because the occurrence key hashes the whole row payload, a Cathay row whose description or balance changes between runs is a new occurrence, not a revision of the old one.
- The deposit contract requires a non-negative running balance. A Cathay domestic row with a negative balance now fails admission instead of committing.
- `financial.mixed.commit`, `src/ledger/pglite/mixed-commit.ts`, its worker registration and channel contract are deleted.
