# Invoice-item categories and purchase category

Status: accepted

Amends [ADR 0011](./0011-orthogonal-transaction-taxonomy-and-enrichment.md) within the purchase-basis Spending of [ADR 0024](./0024-purchase-basis-spending-and-report-deduplication.md).

The glossary and specification already allow a Personal Category on an invoice item, but nothing defines its storage, routing, origin rules, or query contract, and purchase-basis Spending counts unmatched e-invoices that therefore can never be categorized. We make the e-invoice item a second subject of the existing Assertion spine and read each Spending purchase's category at query time. Item-level assertions keep a mixed basket exact and avoid inventing a whole-invoice category that no source evidence supports.

## Subject

An item subject is `(invoice_id, item sequence)`, stable across invoice revisions. The spine gains a subject discriminator rather than a parallel table family: `assertions.target_kind`, transitions, provenance, routes (`subject_kind`), and the current projection accept `einvoice_item` beside `transaction`, with exactly one subject set per row, and a typed item categorization value table joins the categorization family. When a revision keeps an item's facts (name, quantity, amount), its User Assertion continues; when the facts change or the item disappears, the User Assertion is withdrawn and the item falls back to the routed Derived result. Derived results are re-derived for each revision.

An item is applicability-checked as Kind `purchase`. Item categorizations follow the transaction rules: one current code per item, an active User Assertion over the routed Derived result, clearing falls back to that result, and no canonical `other`, `uncategorized`, or confidence state.

## Purchase category

The purchase category is a report-level reading of Spending. It is never stored, never a Category Allocation of a bank transaction, and therefore outside ADR 0011's rule about which evidence may categorize a transaction.

- Bank-only purchase: the transaction's Current Categorization.
- Invoice-only purchase: one code when the invoice has at least one non-negative item and every non-negative item, complete or not, carries that code. A split by code when every item is complete and categorized, the item amounts sum exactly to the invoice total, and each code's net amount is non-negative. Otherwise Unclassified. Negative lines such as discounts never block a single-code reading.
- Linked purchase: user before automatic, then transaction before items. A user transaction category wins, then a user item reading, then an automatic transaction category, then an automatic item reading. A single item code applies to the whole counted bank amount. A split applies only when the item amounts reconcile exactly to the counted bank amount, so a foreign-currency or tipped payment never splits.

A split purchase counts once toward the record count of each code it touches and contributes each code's amount to that code's total.

Changing a purchase's category writes User Assertions on the subject that owns it: the transaction for a bank-only or linked purchase, and every item for an invoice-only purchase. Corrections never become reusable merchant rules.

## First producer

A versioned Derived producer reads e-invoice items. An item-name rule decides first; otherwise the seller rule decides, by tax ID before seller name. A rule that does not match emits nothing. The producer, its compatibility rows, and its `einvoice_item` route change the taxonomy package hash while the package stays `v1` and its seeded row is regenerated, as earlier producer additions did before the first release.

## Display groups

The Spending page rolls codes into 餐飲, 日常, 交通, 購物, 居家, 休閒, and 其他 through one exhaustive, typed mapping shared by the renderer and the query layer, so a newly published code fails to compile until it is placed. Queries filter by code lists. 其他 holds registered codes outside the six named groups and is distinct from the query-time Unclassified bucket.

## Considered options

- One category per whole invoice: rejected because it has no source evidence and loses exact item splits.
- Leave invoice-only purchases Unclassified: rejected because invoice-only records are a large share of purchase-basis spending.
- Write a Category Allocation onto a linked bank transaction from its items: rejected because an ADR 0024 dedup link is report-level and does not establish the contract-proven identity ADR 0011 requires.
- A parallel item categorization event system: rejected because the specification requires one Assertion spine.
- Revision-scoped item subjects: rejected because every source revision would silently erase user corrections.
