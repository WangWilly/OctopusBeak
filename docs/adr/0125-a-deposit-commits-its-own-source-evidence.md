# A deposit commits its own source evidence

Status: accepted

Refined by [ADR 0126](0126-cathay-stages-through-the-deposit-step.md): Cathay commits with the deposit command too, and `financial.mixed.commit` is removed.

Refined by [ADR 0130](0130-a-deposit-admission-returns-its-verdict.md): Fubon's partial admission runs inside its financial admission, not in the workflow.

Refines [ADR 0121](0121-deposit-sources-stage-through-one-step-that-runs-their-admission.md). Settles the unified deposit command that ADR 0121 deferred. Decided in [issue 413](https://github.com/WangWilly/OctopusBeak/issues/413).

## Context

ADR 0121 let a deposit decision carry `withSource`. With it, the shared step staged `financial.mixed.commit`, which commits a separate structural capture and the deposit in one transaction. Only SinoPac and CTBC passed it. HNCB, Post, LINE Bank, Fubon, Yuanta and Yuanta foreign currency staged `financial.deposit.commit` alone.

The deposit command already persists the capture's source evidence. `commitPGliteCanonicalDepositCapture` derives the evidence from the deposit capture (`financialSourceEvidenceFromCapture`). Within one transaction it writes the source capture, scope, pages and every record, then the financial facts. A deposit cannot become visible without its evidence on either path.

What `withSource` added was a second capture on a `capture-evidence` route. It holds the row shape (ordinals, digests, date shapes, amount classes) of the same rows, and no projection or query reads it. HNCB, Fubon and Yuanta build the same kind of capture, but only for source-only accounts. Post, LINE Bank and Yuanta foreign currency have no builder. No recorded decision explains why SinoPac and CTBC carried it.

The two commands also fail differently. The deposit command classifies a ledger error, such as an occurrence conflict, as an item failure, and the run commits its other items. The mixed command lets the error escape unclassified, so the run fails as `worker-failure` (ADR 0054).

One case lost evidence on the deposit path. Fubon's partial admission (`row-status-unresolved`) admitted the posted rows and dropped the rows with a status marker. Only a page row count and digest recorded them.

## Decision

**Every deposit source commits an admitted capture with `financial.deposit.commit`. The deposit capture is the source evidence.**

- `withSource` is removed from `DepositDecision`. SinoPac and CTBC build their structural capture only for a source-only account, as HNCB, Fubon and Yuanta do.
- A row a source declines to book but observed in the requested range travels in the deposit capture as a `statement-evidence` non-transaction record. It is persisted as a source record and never becomes a transaction. Fubon's partial admission now keeps each unresolved row this way. Its keys derive from the row's content and from its repeat count among identical rows, under their own digest prefix, so the same row re-admits as the same occurrence and never collides with the posted row it may later become. Page row counts are the source's row counts again.
- `financial.mixed.commit` stayed for Cathay, which committed every account of a product in one item. [ADR 0126](0126-cathay-stages-through-the-deposit-step.md) removes it.

## Considered options

- **Every source passes `withSource`.** Rejected. The structural capture repeats a redacted view of rows the deposit capture already records, and nothing reads it. Post, LINE Bank and Yuanta foreign currency would each need a new builder and route.
- **Keep both shapes.** Rejected. The shape decided a source's failure mode, and no source needed the difference.
- **Commit Fubon's full structural capture beside its partial deposit.** Rejected. It would bring back the second capture only to hold the unresolved rows, and the deposit capture can already carry them.

## Consequences

- Five deposit commit goldens change. In `ctbc-empty-account-source-only`, `ctbc-two-accounts-inflow-outflow-balances`, `sinopac-domestic-and-foreign`, `sinopac-identical-rows` and `sinopac-no-data-account`, each mixed item becomes a deposit item with the same capture. The source step is dropped, and keys, order and events are unchanged.
- From now on, a SinoPac or CTBC run writes one fewer source capture per admitted account. Captures already stored are not rewritten.
- A ledger conflict on a SinoPac or CTBC deposit now fails only that item. The run commits its other items, as every other deposit source already does.
- A Fubon partial admission now persists its unresolved rows as source records. Its page metadata no longer carries `sourceRowCount`.
