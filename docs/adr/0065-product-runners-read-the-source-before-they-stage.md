# Product runners read the source before they stage

Status: accepted

Follows [ADR 0063](0063-product-collection-run-stages-every-item.md).

## Context

After ADR 0063 every Yuanta and Fubon product runner took the page, its input, the workflow context and the product handle. Six of them also took an optional fifth argument of page steps, such as opening a page, listing accounts, querying, downloading and reading current balances, so checks could replace each browser step with a fake. Each runner named and shaped that argument differently. Checks had to script page steps one by one to reach the logic that builds commit items, and production never passed the argument.

Yuanta fund and Fubon credit card already worked differently: one function read a complete source snapshot from the page, and the runner built items from it.

## Decision

**A product runner reads its source first, then builds and stages from what it read.** The read half is the only part that touches the page. The build half takes the source snapshot, the input, the workflow context and the product handle. It is exported, and checks drive it with snapshots instead of fake page steps. The runner composes the two halves and keeps the four-argument signature, so the fifth argument is deleted.

**Yuanta deposit and Fubon deposit read in two phases.** Yuanta reads current balances only after at least one statement capture was admitted as financial data. Fubon reads them after that, or when a USD-coded composite account deferred its currency proof to the balance table. Both read only when the run was not cancelled. Yuanta's deposit golden pins that a source-only run never opens the balance page. Their build half therefore takes the statement snapshot and one function that reads current balances when the build asks for them.

Yuanta foreign currency, Yuanta loan, Yuanta fund, Fubon deposit and Fubon credit card follow this shape. Fubon loan and Yuanta credit card take no fake page steps and are left as they are. Yuanta credit card later took the same split, with its HTML parsing in `yuanta-credit-card-parser.ts` and its full-or-partial capture decision in the build half.

The single-product workflows (SinoPac, Chunghwa Post, HNCB, CTBC and Yuanta trade) later took the same split. Their bank-specific bags of fake page steps are deleted. Each provider workflow keeps one optional product runner shaped like the multi-product orchestrators' runners: a `collectDeposit` field, or a positional `collectSecurities` argument for Yuanta trade. SinoPac also keeps its attached credit-card transport, and HNCB's run still takes the session check and the Attached Preview Products from sign-in. The SinoPac and HNCB goldens record read-time events, such as account listing and decoding, between each account's validation events. For these two banks the read half also admits each account's capture structure as it reads it, and their goldens run the real read half against a fake source port. That keeps the goldens byte-identical.

## Considered options

- **Keep the fake page steps under one name.** Rejected. Checks would still script page steps to test how commit items are built.
- **Read current balances whenever accounts exist.** Rejected. A source-only run would open the balance page and fail on an empty balance table.

## Consequences

- The read half has no unit checks in this change. The fakes skipped it before as well, and real-Chromium checks with fixture pages are left for a Yuanta eBank page module. The deposit commit goldens therefore pin commit items and the build half's events, not the read half's query and download activity.
- Yuanta foreign currency reads current balances whenever accounts exist, which is when the build admits them, and no longer stamps the rows with the admitted capture's financial authority. Nothing read that field, and the staged commands are unchanged. When an account would fail admission and the balance table cannot be read, the product now fails with the balance error instead of the admission error; it stages nothing either way.
- In Yuanta deposit, Yuanta foreign currency, Yuanta loan and Fubon deposit, a validation or admission error on an earlier account surfaces after later accounts were read, instead of before. The product still stages nothing.
- Yuanta loan checks an account's text integrity while reading and its page completeness while building, so an account that is both incomplete and corrupt now fails as `source-integrity-failed` instead of the completeness error. The product still stages nothing.
- Unused page seams are deleted, including Yuanta loan's `readCounterpartyAccountEvidence` and `explicitRelationLinks`.
- Yuanta credit card's input schema no longer accepts a caller-supplied `canonicalHumanAttestation`. The orchestrator always replaced it with the attestation derived from the credentials, so a malformed value is now dropped instead of failing input validation, and staged commands are unchanged.
