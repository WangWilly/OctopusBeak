# The Product collection run stages every item

Status: accepted

Extends [ADR 0060](0060-product-collection-run-owns-every-verified-product-outcome.md). Keeps the command choice that [ADR 0054](0054-domestic-deposit-admission.md) leaves with each workflow.

## Context

`collectSelectedProducts` handed each collector a bare array and trusted it. The rules for what may enter that array had no owner:

- Yuanta and Fubon checked that every staged command's text was intact. Yuanta foreign currency checked the same commands twice, and the Yuanta and Fubon orchestrators checked them a third time. The other nine product collections never checked their commands.
- Every workflow wrote its provider into each item by hand, about 46 literals across 18 files. The Yuanta orchestrator then re-checked those literals.
- Yuanta and Fubon reached their products through eight `*ForApp` adapters. Each adapter only renamed ports into that product's own option bag, with fields such as `deferredCommitItems`, `collectOnly`, `sourceText`, `signal`, `now` and `reportActivity`. The products re-checked at run time that the ports were present, although each product runner had exactly one caller.
- A collector reported its own `itemCount`, which the run compared with the array length after collection. Duplicate identities were also found only after collection.

Because none of these rules could be reached through the interface, about a dozen check files asserted them by searching the workflow source for call order.

## Decision

**The run stages every item.** A collector receives one product handle with `stage`, `reportActivity` and `event`. `stage` takes the product label, item key, command and optional relation commands. The run fills in the provider it was given once, rejects a command whose text is not intact, and rejects a repeated provider, product and item key as soon as it is staged. The run counts staged items itself, so a collector no longer reports `itemCount`.

**The workflow still chooses what it stages.** The command, the product label, the grouping and the relation commands stay with the workflow, as ADR 0054 requires. The product label stays per item because one product type stages several kinds, such as `domestic-deposit` and `current-balance` under `deposit`, and the deposit commit goldens pin them.

**A failed check keeps today's outcome.** A command whose text is not intact fails that product as `source-integrity-failed`, and the run continues with the next product. A repeated identity stops the run as `workflow-failed`. Because the run now stops while the collector is still staging, that failed product reports no items, where it used to report the count its collector returned.

**Product runners take the handle directly.** Each Yuanta and Fubon product runner takes the page, its parsed input, the workflow context and the product handle. The `*ForApp` adapters, `collectOnly` and the run-time port checks are deleted.

## Considered options

- **Move only Yuanta and Fubon to the handle.** Rejected. Two staging forms would remain, and the integrity rule would still have no single owner.
- **Bind the product label to the product type id.** Rejected. It would merge item kinds that the uniqueness check and the deposit commit goldens keep apart.
- **Let the run also call the financial commit and decide `sourceOnly`.** Deferred. It is a separate change to the run's commit seam.

## Consequences

- The nine collections that did not check their commands now do. A command can hold a replacement character only when the source text was already corrupt, so a healthy source sees no change.
- Yuanta fund items carry the provider `yuanta` instead of `yuanta-fund`. The label appears only in commit diagnostics and the uniqueness check. The canonical integration namespace inside the command is unchanged.
- `src/lib/automation/product-collection.check.ts` covers the staging rules through the run's interface, and the source-searching assertions about staging are deleted.
