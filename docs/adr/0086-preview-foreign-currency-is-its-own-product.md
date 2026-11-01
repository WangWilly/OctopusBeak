# Preview foreign currency is its own product

Status: accepted

## Decision

The verified CTBC and Fubon sources collect only TWD deposits. Their foreign-currency accounts can be collected only as Preview Financial Data. [ADR 0047](0047-preview-sources-outside-canonical-admission.md) hides a Preview Source while a verified source covers the same Institution and product. If those accounts stayed in the `deposit` product, the verified TWD coverage would hide them.

So non-TWD deposit accounts at such an Institution use a separate preview product, `foreign_currency`. The verified Cathay source already splits its streams the same way: `foreign_currency` is a stream of its own. A person chooses the product in the Statement Selection independently of deposits ([ADR 0036](0036-explicit-statement-selection-and-product-results.md)).

How each bank collects the product:

- Fubon collects it as an Attached Preview Product during the verified website sign-in ([ADR 0051](0051-attached-preview-products-on-verified-sources.md)).
- CTBC collects it in the existing App-protocol Preview Source, `ctbc-credit-card`. That source keeps its ID, because the ID keys stored preview data and Sign-in Details.
- Mega, Shin Kong, and Rakuten keep their foreign-currency accounts under `deposit`. No verified source covers these Institutions, so the coverage rule never applies to them.

## Considered options

- **Judge preview coverage per currency, as [ADR 0048](0048-direct-source-precedence-per-currency.md) does for Intermediary sources.** Rejected. It would leave foreign currency hidden inside `deposit`, so the person could not choose it apart from TWD deposits. It would also make coverage depend on the currencies the verified source happens to collect, not on the products it declares.
