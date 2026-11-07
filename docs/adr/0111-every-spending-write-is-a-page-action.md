# Every Spending page write is a page action

Status: accepted

Extends [ADR 0105](0105-spending-page-actions-publish-through-the-ledger.md), which sent Pairing decisions through the Spending page actions. Keeps User Assertions for a purchase's category ([ADR 0038](0038-invoice-item-categories-and-purchase-category.md)).

ADR 0105 covered only Pairing: confirming, denying, or revoking one pair. Two other writes on the Spending page used their own commands: setting a purchase's category, and confirming every shown strong pair in one batch. After each one, the review store re-read the whole page with `financialPage.reload("spending")`. The live view had already recomputed the page from the commit. So each write read the page twice, and nothing held the recompute while the write ran.

**Every write the Spending page makes is a page action.**

- `SpendingPageActionRequest` has two more kinds. `category` sets or clears one purchase's category. `strong` confirms the shown strong pairs in one commit, or writes nothing.
- `decide()` reads a subject's records before and after the write. The subject is a set of invoice and transaction identities: one pair, a purchase's own identities (both members for a linked purchase), or every pair in a batch. `decide()` returns the summary delta for the subject.
- A page action answers with its committed result, or, for a strong batch, with a conflict: a shown pair is no longer pending or no longer strong, nothing was written, and the reply names the strong set to offer instead. A conflict is not a settled result, so the live view does not publish anything for it.
- `PurchaseSpendingSession` runs every action and takes its result. The review store keeps its own busy, conflict, and error state, and calls the session for the write.
- The `financial.spending.setPurchaseCategory` and `financial.spending.confirmStrongCandidates` operations are gone.

## Considered options

- **Delete only the extra reload.** Rejected. The live view would still recompute the whole page for every write, and ADR 0105's checks would not cover these writes.
- **Report a strong-batch conflict as an error.** Rejected. The renderer needs the recomputed strong set, and an error loses its fields across IPC.

## Consequences

- One rule publishes every Spending write, and the page-action checks cover all of them.
- A strong batch still accepts pairs shown at an older version. Its delta is relative to the version it validated. The live view reads a page at another version again, and the renderer leaves a page that has not reached that version for the live publication to bring forward.
- The review store's `refreshSummary` is used only to recover a read that found its version stale.
