# Interest and fees is a Personal Category Spending and Cash flow share

Status: accepted

Interest charged and bank, card and loan fees had no Personal Category, so both pages showed them as Unclassified. Spending already counted bank fees, card fees and card interest. Cash flow also counted a loan's interest and fees (ADR 0138), and its outflow groups are Spending's category groups. Issue #481 decides how these rows get a category and whether Spending counts loan charges too.

**A new Personal Category, `interest_and_fees` (利息與手續費, Interest And Fees), rolls up into the 其他 Spending category group.** It is a taxonomy addition only. The code, its definition and labels, and its applicability rows for every Kind that admits a Personal Category are added, and no existing code changes. An operational seed step adds the rows to an existing store.

**The Kind derives it, and the person's categorization wins.** A new producer, `kind/category-enrichment` v1, reads a transaction's current Kind and nothing else. `interest.charged`, `fee.bank`, `fee.card` and `fee.loan` give `interest_and_fees`. `fee.investment` gives nothing, since an investment-account row never counts (ADR 0138). The producer runs in the projection right after the Kind is selected. It records a Derived Assertion through an enrichment run like any other producer: evidence kind `kind`, the Kind code as its source value, and the Kind assertion it read. Its one route is global, because the rule does not depend on the stream. When the Kind changes to another fee Kind, a new assertion supersedes the old one. When the Kind stops being one of the four, an unsupported output withdraws it. A User Categorization still takes precedence, and clearing it falls back to the Derived category. Rows captured earlier get the category on the next store open through a new `kind-rederivation` entry.

**Spending counts a loan's interest and fees.** Purchase-basis spending is a view of consumption. Interest and fees are real costs whichever account charges them, and nobody would predict a rule where card interest counts but mortgage interest does not. So Spending adopts the ADR 0138 loan-charge rule. On a `loan` stream account, an inflow whose Kind is `interest.charged` or `fee.loan` is included. It becomes a bank-only purchase record (`transaction:<id>`) on its effective date, with its booked amount as spending. One canonical predicate, `isLoanCharge` in `loan-charge.ts`, decides this for Cash flow's rule, Spending's inclusion, and the Purchase report's SQL rows. A loan charge is never a Pairing entry, a deterministic or direct candidate, or a refund original, so no invoice can pair with it. Loan principal (`payment.loan`), `loan.disbursement` and the deposit-side repayment stay excluded, so nothing counts twice. A category set from Cash flow on such a row now shows in Spending. Spending inclusion policy `gross-posted-outflow` moves to v2.

For one period and currency, Cash flow's 利息與手續費 outflow equals Spending's 利息與手續費 total. Both read the same Current Categorization. For these Kinds, both also date a row the same way: the consume date when a card row has one, otherwise the effective date.

## Considered options

- **A Cash-flow-only group for interest and fees.** Rejected. Cash flow's outflow groups are Spending's category groups, and Spending already counts bank fees, card fees and card interest. They would stay Unclassified there.
- **Exclude every interest and fee from Spending.** Rejected. These are costs the person pays, and Spending already counted them. Removing them would change Spending's totals for no gain in meaning.
- **Count loan charges in Cash flow only.** Rejected. The category totals of the two pages would disagree.
- **Derive the category at read time with no assertion.** Rejected. A Derived categorization must carry a producer, route and lineage, like every other automatic result.

## Consequences

- The global route overlaps the Cathay domestic-deposit category route, which has no writer of transaction categories in PGlite today. If a Cathay producer starts writing categories, the precedence between the two routes needs a decision.
- A card account's own interest or fee line still reads `purchase` from direction alone, so it gets this category only once a producer gives it an interest or fee Kind. Today `interest.charged` and `fee.card` come from deposit labels.
- Spending's SQL purchase rows already include a `loan.disbursement` outflow that the TypeScript inclusion excludes. That gap predates this decision and is not fixed here.
