# Orthogonal transaction taxonomy and enrichment

Proposed amendment: [ADR 0038](./0038-invoice-item-categories-and-purchase-category.md) adds the e-invoice item as a second categorization subject of the Assertion spine and defines the query-time Purchase category for purchase-basis Spending.

Accepted amendment: [ADR 0024](./0024-purchase-basis-spending-and-report-deduplication.md) governs purchase-basis Spending and traceable one-to-one report deduplication, including explicit user confirmation. It supersedes conflicting report-level exclusions below without relaxing canonical identity, source admission, financial-fact immutability, or exact transaction-allocation requirements.


Status: accepted

OctopusBeak models transaction enrichment as independent, typed dimensions rather than one provider-shaped category field: Transaction Kind describes the financial operation, Personal Category describes personal-finance purpose, Counterparty Participation describes who took part and in what role, and user-owned Transaction Tags provide many-valued organization. Transaction Relations, account-relative direction, posting status, Statement membership, and financial report inclusion remain separate financial semantics.

The first version publishes immutable, versioned product taxonomies for Transaction Kind, Personal Category, Counterparty Role, and Kind/Category applicability. Published code meaning and parentage never change; corrections deprecate an old code and add a new one. Taxonomy packages live in the repository, pass fixture and immutability checks, seed the canonical database transactionally, and ship only inside immutable desktop releases. Installing a package does not reclassify existing Assertions.

Source, Derived, and User enrichment continues through the canonical Assertion spine, provenance, complete-scope Import Runs, Canonical Financial Commits, and knowledge-time query rules established by ADRs 0008 and 0010. Current enrichment is a rebuildable typed projection, not a second event system. Unsupported optional enrichment is absent; an unresolved contract-required Kind or incompatible Kind/Category cancels the attempted Capture. Canonical storage contains no `other`, `uncategorized`, confidence contest, conflict status, or guessed fallback.

The complete registries, permissions, physical responsibilities, projection precedence, report boundaries, and verification requirements are defined in [Transaction taxonomy and enrichment specification](../specs/transaction-taxonomy-and-enrichment.md).

## Accepted amendment: evidence-ordered transaction-kind fallbacks

The Derived Transaction Kind producer uses an evidence-first order for asset-account outflows. Explicit evidence for `transfer.*`, `payment.credit_card`, `payment.loan`, `cash.withdrawal`, or `investment.*` takes precedence; an ordinary non-investment outflow that has no such evidence falls back to `purchase`, while an evidenced `fee.bank` remains `fee` and follows the existing Spending inclusion policy. This makes ordinary account outflows available to Spending without counting transfers, bill payments, withdrawals, or investment funding as purchases.

The taxonomy adds `receipt` for an inflow whose economic purpose cannot be proven. `receipt` is a Derived fallback rather than an income assertion and is excluded from income totals; later evidence may supersede it with `income`, `refund`, `transfer.*`, `loan.disbursement`, or another registered kind.

Self-transfer and investment funding require either an explicit source code or fixed label, or a traceable relation between known owned accounts with exact amount and currency, opposite directions, and close financial dates. Generic labels such as 「轉帳」 or 「買入」 alone are insufficient. The trade-off is deliberate: direction and ordinary descriptions provide useful coverage for purchases, but do not establish the economic purpose of movements that can distort Spending or investment totals.

Credit-card payment derivation follows the same evidence order. A provider-verified source grammar that combines a payment channel with an explicit credit-card-payment business label is sufficient for a bank outflow to become `payment.credit_card`, even without a matching Statement. Taipei Fubon documents its mobile and online banking flows with the labels 「繳本行信用卡款」 and 「繳富邦信用卡款」; its deposit descriptions combine a payment-channel action with the credit-card-payment label. The grammar may accept variable issuer text and trailing references, but treats them as opaque and never assigns meaning from their length, prefix, shape, or a hardcoded observed value. See [Taipei Fubon payment methods](https://www.fubon.com/banking/personal/digitalService/payment_intro/payment_intro.htm).

A credit-card payment relation remains a separate, stronger claim. It requires exactly one owned-card Statement with the same exact amount and currency and an outflow date from Statement issue through payment due date. Equal competing Statements, amount or currency differences, and payments outside the window do not create the relation; the source-proven Kind remains valid independently.

Yuanta scheduled fund subscriptions use a provider-scoped source grammar rather than a keyword or destination-account rule. A domestic-deposit outflow is `investment.trade.buy` only when the complete description identifies a withdrawal, structured payment reference, Yuanta operation reference, structured fund reference, scheduled-subscription operation, institution reference, subscription event discriminator, and terminal fund-system marker in their contract-defined order. The identifiers remain variable and opaque. The exact phrase without the surrounding structure, a similar event discriminator, or the same shape from another provider is insufficient.

## Consequences

- A merchant name, merchant activity code, Personal Category, and Transaction Kind cannot silently substitute for one another.
- A transaction has either one current Personal Category, one exact complete Category Allocation, or no categorization. Partial allocations never participate in reports.
- Financial report inclusion is decided before categorization. Included uncategorized amounts remain visible in a query-time Unclassified bucket; missing semantics required by a report produce an explicit eligibility-coverage gap.
- Counterparty identity is reusable only through a stable producer-scoped key. Similar names never merge identities; user aliases change display only.
- Confidence may support one producer's admission threshold but never becomes canonical uncertainty or runtime authority ranking.
- User Assertions may select a registered category, provide a complete allocation, override display, or manage Tags; they cannot change Kind, Counterparty role/identity, or financial facts.
- Historical enrichment uses the Transaction's financial date for period membership and Canonical Knowledge Point for what was known. It has no separately backdated financial `effective_at`.

## Rejected alternatives

- Copy Plaid Personal Finance Categories or Investments type/subtype directly: rejected because provider conventions combine concerns that OctopusBeak keeps separate.
- One universal merchant/category field: rejected because non-merchant transactions, financial operation, merchant activity, and personal purpose have different identity and authority.
- User-defined category trees in the first version: rejected in favor of a stable product taxonomy plus reusable Tags.
- Fuzzy Counterparty merging or global merchant identity: rejected because names do not prove identity across producers.
- Persist `unclassified`, eligibility, low-confidence, or conflict statuses: rejected because they are query results or admission failures, not canonical facts.
- Let Category admit or exclude financial amounts: rejected because descriptive organization cannot rewrite financial semantics.
