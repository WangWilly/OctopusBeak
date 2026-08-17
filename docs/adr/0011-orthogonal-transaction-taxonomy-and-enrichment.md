# Orthogonal transaction taxonomy and enrichment

Status: accepted

OctopusBeak models transaction enrichment as independent, typed dimensions rather than one provider-shaped category field: Transaction Kind describes the financial operation, Personal Category describes personal-finance purpose, Counterparty Participation describes who took part and in what role, and user-owned Transaction Tags provide many-valued organization. Transaction Relations, account-relative direction, posting status, Statement membership, and financial report inclusion remain separate financial semantics.

The first version publishes immutable, versioned product taxonomies for Transaction Kind, Personal Category, Counterparty Role, and Kind/Category applicability. Published code meaning and parentage never change; corrections deprecate an old code and add a new one. Taxonomy packages live in the repository, pass fixture and immutability checks, seed the canonical database transactionally, and ship only inside immutable desktop releases. Installing a package does not reclassify existing Assertions.

Source, Derived, and User enrichment continues through the canonical Assertion spine, provenance, complete-scope Import Runs, Canonical Financial Commits, and knowledge-time query rules established by ADRs 0008 and 0010. Current enrichment is a rebuildable typed projection, not a second event system. Unsupported optional enrichment is absent; an unresolved contract-required Kind or incompatible Kind/Category cancels the attempted Capture. Canonical storage contains no `other`, `uncategorized`, confidence contest, conflict status, or guessed fallback.

The complete registries, permissions, physical responsibilities, projection precedence, report boundaries, and verification requirements are defined in [Transaction taxonomy and enrichment specification](../specs/transaction-taxonomy-and-enrichment.md).

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
