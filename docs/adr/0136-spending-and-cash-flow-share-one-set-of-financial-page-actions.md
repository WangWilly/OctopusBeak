# Spending and Cash flow share one set of Financial page actions

Status: proposed

Extends [ADR 0111](0111-every-spending-write-is-a-page-action.md), which made every Spending write a Spending page action. Keeps [ADR 0105](0105-spending-page-actions-publish-through-the-ledger.md)'s publication rule for the Spending page.

The Cash flow page writes some of the same facts as Spending: a transaction's category, which both pages show. It also writes facts of its own: a note, a Category Allocation, a Transaction Tag, and the confirm, deny, and revoke decisions for a Cash-flow transfer link. If each page kept its own action for a category change, the same User Assertion would have two write paths.

**The page actions become Financial page actions, one table for both pages.** Each kind has one entry. Each page decides how to take a settled action. Spending keeps applying its exact delta. In the first version, Cash flow reads its page again after any committed action. A delta for Cash flow can come later without adding a second write path.

## Considered options

- **Give Cash flow its own page actions.** Rejected. A category change would then have two implementations that must agree.
- **Let Cash flow call ledger commands directly and rely on the live view.** Rejected. Nothing would hold the recompute while the write runs. ADR 0111 removed that pattern from Spending.
