# Credit-card Query Inventory, a new identity epoch, and a user-triggered Canonical Reset

Status: accepted

Amends [ADR 0040](0040-per-bucket-occurrence-continuity-and-unbilled-to-billed-supersession.md) (the billed-progression check) and broadens the Canonical Reset of [ADR 0009](0009-reset-legacy-financial-data-before-canonical-collection.md) from a one-time legacy cutover to an action a person can trigger.

## Context

Fubon, Yuanta, and E.SUN credit-card captures each declared their Query Inventory in their own code:

- The "six billed periods plus one unbilled grid" completeness rule was written four times: twice in admission and twice in the workflows.
- Query Bucket keys were hand-built strings, assembled in the workflow for Fubon and in admission for Yuanta and E.SUN. The E.SUN partial-month fix added one more string convention in one bank's module.
- The store enforced billed progression only when `integrationNamespace === "fubon"`. That check rejected any unbilled member in a group that once had a billed member, so it also rejected a second identical purchase on the same day that posted after the statement closed.

## Decision

**One Credit-card Query Inventory module owns Query Buckets for every credit-card source.**

- It defines Query Buckets as a typed union: statement period, unbilled listing, timeline month, partial timeline month, and history range.
- It encodes each bucket with one canonical encoder into the existing text columns. The schema does not change.
- It owns two inventory shapes:
  - a statement grid for Fubon and Yuanta, accepting each bank's terminal evidence;
  - a month timeline for E.SUN.
- Admission builds bucket keys through the module. Workflows report what they queried and call the same grid check for early diagnosis.

**Billed Monotonicity is a property of the bucket kind.**

- Statement buckets and month buckets (whole or partial) promise that, when queried again, an occurrence group's billed members never decrease.
- Unbilled buckets and history-range buckets make no promise.
- The store reads the promise from the bucket kind, not from a flag on the capture, and compares captures only within one contract version.
- An unbilled member appearing beside billed members is accepted.
- The Fubon-only `assertFubonBillingProgression` is deleted. Every credit-card transaction capture must carry its Query Inventory.

**The changed bucket encoding starts a new identity epoch for every credit-card route of the three sources.**

- That includes the used-credit routes, so balances keep landing on the same account.
- Existing credit-card data is not migrated.

**Old-epoch data leaves only through a Canonical Reset the person triggers.**

- Settings offers 「刪除所有財務資料」, which runs a Canonical Reset.
- Settings also offers 「清除所有登入資料」, which runs a Sign-in Erasure.
- Both actions cancel active runs and wait until those runs are terminal. Both pause scheduled collection while they work and ask for a two-step confirmation.
- While a source connection still holds an old-epoch credit-card account, the store refuses new-epoch captures for that source. It does not admit a second account.
- The run reports that a reset is needed, in the same class as needs setup: CAPTCHA retry campaigns do not retry it, and scheduled collection skips it after a single notification.
- After a Canonical Reset, no collection starts by itself. Post-reset recollection follows the normal schedule, and the completion notice offers to collect every source now.

## Considered options

- **Keep the bucket strings byte for byte.** This needs no epoch and no rebuild. It was rejected in favour of one typed encoding, accepting a one-time rebuild.
- **Bump only the contract version.** Transaction identity would survive, and only the first new capture would skip the loss guard. It was rejected because the person preferred a clean rebuild over carrying old-epoch history forward.
- **Purge the old epoch automatically**, either in the first new-epoch commit or at upgrade. This was rejected: deleting financial history stays an explicit act of the person. Until they act, refusing admission keeps the overview stale but never double-counted.

## Consequences

- After upgrading, each affected credit-card source fails until the person runs a Canonical Reset. That reset clears every source, not only the three card sources. Post-reset recollection then repopulates the store.
- A continuation that only the old Fubon rule would have caught, such as a billed member reverting to unbilled while the group size stays the same, is still caught: the billed count decreases.

## Implementation notes

- Route keys and contract versions do not change. A store opens only when its installed contract catalog equals the registry ([ADR 0035](0035-source-contract-catalog-and-rule-admission.md)), so a new route would stop every existing store from opening, and the person could not reach the reset. Only the identity epochs change.
- Each card source's human-attestation contract module declares its current and superseded identity epochs. Each credit-card route registration lists the persisted keys of the superseded epochs, and the store refuses a capture with `canonical-reset-required` while the capture's Source Connection holds a Financial Account under one of them.
- The run keeps its own status (`partial` when another product committed, otherwise `failed`) with error code `canonical-reset-required`. The task row shows the reset requirement only while the store still refuses the source, so after a reset the row, Sync all, and scheduled collection treat the source as usual again.
