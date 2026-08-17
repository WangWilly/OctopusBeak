# Transaction taxonomy and enrichment specification

Status: implementation-ready planning specification

This specification resolves GitHub issue 125. It extends [Canonical financial storage specification](./canonical-financial-storage.md) with the first-version universal Transaction Kind, Personal Category, Counterparty, display, Tag, routing, publishing, query, and verification contracts. Plaid is a coverage comparison only; OctopusBeak does not integrate with Plaid or adopt Plaid provider identity, sign, type, or category semantics.

## 1. Independent dimensions

One Financial Transaction may have the following independent enrichment:

- **Transaction Kind**: what financial operation occurred;
- **Personal Category**: the personal-finance purpose of a compatible transaction;
- **Counterparty Participations**: who participated and in which registered roles;
- **Transaction Tags**: user-owned, many-valued organization; and
- **Transaction Display Label**: a typed presentation result with explicit origin.

Do not infer Transaction Relation, direction, posting status, account type, Statement membership, identity, or report eligibility from these fields. Integration contracts decompose source-specific values into the canonical dimensions they actually prove.

## 2. Taxonomy registries

### 2.1 Transaction Kind

Publish the following first-version hierarchy. A producer asserts the most specific code it can prove and may stop at any registered parent.

```text
purchase
transfer
  internal
  external
  investment_contribution
  investment_withdrawal
  security_position
payment
  bill
  credit_card
  loan
cash
  deposit
  withdrawal
income
  employment
    salary
    bonus
  business
  pension
  government_benefit
  rental
  reward
  dividend
  investment_distribution
fee
  bank
  card
  loan
  investment
interest
  earned
  charged
tax
  payment
  refund
  withholding
refund
reversal
adjustment
loan
  disbursement
investment
  trade
    buy
    sell
    sell_short
    buy_to_cover
    reinvestment
  corporate_action
    split
    merger
    spin_off
    exercise
    assignment
    expiration
```

Transaction Kind is optional enrichment unless an integration contract declares it necessary to interpret a record kind, such as an investment trade whose buy/sell semantics govern cash and quantity. Missing optional Kind is absence. Missing, unsupported, or ambiguous required Kind cancels the attempted Capture.

`transfer.internal` proves only that the source identifies a movement between the person's accounts. A `transfer_counterpart` Relation additionally requires both canonical Transaction endpoints and contract-proven linkage. `refund` and `reversal` likewise do not establish `refund_of` or `reversal_of` Relations by themselves.

### 2.2 Personal Category

Publish only these first-version top-level codes:

```text
food_and_groceries
dining
alcohol_and_tobacco
clothing_and_footwear
housing_and_utilities
household_goods_and_services
healthcare
transportation
travel
information_and_communication
recreation_sports_and_culture
education
personal_and_family_care
insurance
taxes_and_government
gifts_and_donations
work_and_business
```

Do not publish `other`, `general`, `unknown`, `uncategorized`, income, transfer, payment, or fee as Personal Categories. A detailed child may be added only with a non-overlapping definition, real product use case, positive/negative/boundary fixtures, and proof that aggregation to its parent is semantically safe.

The product manages this taxonomy. First-version users may select registered codes but cannot create, rename, move, or delete taxonomy nodes.

### 2.3 Category applicability

Personal Category is allowed for:

- `purchase`;
- general `payment`, `payment.bill`, and `payment.loan`;
- `fee` and its descendants;
- `interest.charged`;
- `tax.payment`, `tax.refund`;
- `refund`, `reversal`; and
- future descendants explicitly registered as compatible.

It is not allowed for:

- `transfer` and its descendants;
- cash deposit or withdrawal;
- `income` and its descendants;
- `interest.earned`;
- `payment.credit_card`;
- `loan.disbursement`;
- `investment` and its descendants; or
- `adjustment`.

An absent Kind cannot be filled with a Category. One atomic producer output may admit a compatible Kind and Category together. An incompatible Source or Derived pair is a producer/contract error; an incompatible User request is rejected without modifying the Transaction.

### 2.4 Counterparty roles

Publish these first-version roles:

```text
merchant
marketplace
payment_platform
financial_institution
income_source
government
person
```

Every Counterparty Participation has exactly one role and provenance. It may have an observed name without a reusable reference. Unsupported role is absence, never `other`.

## 3. Categorization modes

At one Canonical Knowledge Point, Current Categorization is exactly one of:

1. one registered Personal Category;
2. one complete Category Allocation; or
3. absent.

A Category Allocation has two or more non-negative exact components and must atomically reconcile to the unchanged booked Transaction amount in its booked currency. Currency conversion is allowed only with explicit conversion evidence. Any missing component, remainder, duplicate target, currency mismatch, or arithmetic mismatch rejects the complete allocation.

Invoice items may derive a Transaction allocation only after contract-proven invoice/Transaction matching and exact complete reconciliation. Otherwise item categories remain attached to the invoice items and do not categorize the Transaction.

An active complete User Categorization supersedes the user's previous single/allocation mode atomically and takes projection precedence over routed automatic output. Clearing it withdraws the user lineage and falls back to the current routed automatic result. A failed or partial Import Run preserves the previous automatic result. Only a successful complete-scope run that proves the prior result unsupported may withdraw a whole allocation; it never retains partial components or guesses a single category.

### 3.1 Refund and reversal inheritance

A versioned Derived producer may inherit categorization only through a valid `refund_of` or `reversal_of` Relation:

- a full reversal may inherit the original categorization;
- a partial refund of a single-category original may inherit that category;
- a partial refund of an allocated original must have its own complete evidence-backed or User Allocation and cannot be proportionally guessed; and
- without a relation, the refund/reversal requires its own categorization or remains absent.

A successful complete-scope rerun supersedes or withdraws inherited categorization after the original category or Relation changes. A failed rerun preserves it. A User Categorization on the refund/reversal remains authoritative.

## 4. Counterparty identity and display

A reusable Counterparty Reference has natural identity `(producer_namespace, producer_entity_key)`. Names are never keys or uniqueness constraints. Different producers never merge references, even when names match.

A reference may retain:

- Source/Derived display name;
- Source/Derived legal name; and
- an optional contract-validated registered identifier consisting of scheme, jurisdiction, and value, such as a Taiwan seller business number.

A Counterparty Participation retains role, observed name, optional reference, provenance, and optional source classification scheme/code. A merchant activity code such as ISO 18245 MCC describes business activity; it is not Personal Category, though a versioned Derived producer may use it as evidence.

Do not promote first-version logos, websites, phone/email, social profiles, full address, geolocation, opening hours, inferred corporate groups, or unused provider fields. A compact Source Record may retain a field only when the current contract or derivation requires it.

Current display precedence is:

1. transaction-specific User display override;
2. User alias on the selected stable Counterparty Reference;
3. routed Source/Derived display for the selected participation; and
4. source Transaction description.

Role precedence for selecting one display participation is versioned by Transaction Kind and producer contract. Selection never removes other participations or creates financial authority. Falling back to Transaction description returns `display_counterparty = absent`; readable text never fabricates identity. Aliases and overrides change display only and never merge references, alter roles, select a different participation, or change Kind/Category.

## 5. Tags

A Transaction Tag is user-owned and has a stable local ID, renameable display label, and `active | archived` lifecycle. The normalized current label—trimmed, Unicode-normalized, and case-folded—is unique in the user scope while preserving the chosen display form.

Every Transaction/Tag association has an independent User Assertion lifecycle. Removing a Tag from one Transaction withdraws only that link. Ordinary tag deletion archives the Tag and may bulk-withdraw current associations while preserving assertion history. Hard historical removal belongs to a separate user-data deletion workflow.

Source and Derived producers cannot create or apply Tags. Tags never allocate money, change report inclusion, establish identity, or carry source meaning. The first version has no reusable future merchant categorization rule; a bulk categorization action creates explicit User Assertions for its selected targets only.

## 6. Origins, routing, and confidence

Allowed origins are:

| Enrichment | Source | Derived | User |
| --- | --- | --- | --- |
| Transaction Kind | yes | yes | no |
| Personal Category / Allocation | yes | yes | yes |
| Counterparty role / reference | yes | yes | no |
| Counterparty display | yes | yes | yes |
| Transaction Tags | no | no | yes |

A Source Assertion is a contract-versioned translation or conservative parent mapping of an explicit source field without added interpretation. Mapping from merchant name, free text, MCC, invoice items, or combined fields is a Derived Assertion. Unsafe or ambiguous optional mapping produces absence.

Exactly one versioned Automatic Enrichment Authority Route selects the Source or Derived producer for each declared subject/field scope. Routes, not recency or confidence, select producers. Missing optional output is absence. Overlapping active routes fail admission or projection rebuild.

A producer may record a calibrated confidence score in lineage metadata and declare a fixture-tested threshold. One unique result above threshold creates one Derived Assertion; a low score, tie, or unsupported case creates none. Scores never create candidate rows, a low-confidence canonical state, cross-producer comparison, or runtime ranking. A successful complete-scope run may withdraw a prior result when the new producer version proves it unsupported; failure or partial output changes nothing.

All enrichment changes reuse `canonical_commits`, `assertion_lineages`, `assertions`, `assertion_transitions`, typed assertion values, and provenance from the canonical store. Do not create another enrichment event system.

## 7. Physical responsibilities

Extend the canonical schema with typed families equivalent to the following; exact SQL names may change only if all constraints remain mechanically enforceable.

```text
Taxonomy registry
├─ taxonomy_versions
├─ taxonomy_codes
└─ taxonomy_code_applicability

Transaction enrichment
├─ transaction_kind_assertion_values
├─ transaction_categorization_values
├─ category_allocation_sets
└─ category_allocation_components

Counterparty
├─ counterparty_references
├─ counterparty_external_identifiers
├─ counterparty_participations
└─ counterparty_display_assertion_values

User organization
├─ user_tags
├─ user_tag_label_revisions
└─ transaction_tag_assertion_values

Routing and projection
├─ automatic_enrichment_authority_routes
├─ enrichment_producer_versions
├─ current_transaction_enrichment
├─ current_category_allocations
└─ current_transaction_tags
```

Required constraints:

- Assertions reference an exact `(taxonomy_id, taxonomy_version, code)` row through typed foreign keys.
- Published code meaning, definition, and parent are immutable; deprecated codes remain readable and reject new Assertions.
- Single category, complete allocation, and absence are mutually exclusive in one selected projection.
- Allocation components use exact-decimal types and cannot become current until the complete set reconciles.
- Counterparty Reference is unique by producer namespace and producer entity key; no name uniqueness or fuzzy match exists.
- Participation role and origin are required; reference is optional; observed name may be present.
- Transaction/Tag links accept User origin only.
- Confidence remains producer-version lineage metadata and is neither projected nor indexed for authority selection.
- One Automatic Enrichment Authority Route is active per declared scope at a Canonical Knowledge Point.
- Every current row references selected Assertion and route where applicable and is fully rebuildable.

## 8. Query contract

Current and Historical Projection Queries return typed enrichment instead of asking product modules to interpret Assertions:

```text
kind
├─ code
├─ taxonomy version
└─ assertion origin

categorization
├─ mode: single | allocated | absent
├─ selected assertion
└─ category or complete allocation components

counterparties[]
├─ role
├─ observed name
├─ optional reference
└─ provenance

display
├─ label
├─ origin
└─ optional selected counterparty

tags[]
classification coverage
report eligibility coverage
```

Enrichment uses knowledge time only. It inherits the Transaction's financial date for report-period membership and has no separately backdated `effective_at`. A current-knowledge report may therefore reorganize an old Transaction; a Canonical Knowledge Point cutoff reproduces what the application knew and displayed then.

Financial report inclusion is a separate, versioned policy evaluated from admitted financial semantics before Category, display, alias, notes, or Tags. An included Transaction with absent categorization contributes its whole amount to a query-time Unclassified bucket and to classification-coverage metrics. Unclassified is not stored or selectable.

If an inclusion policy requires a missing optional Kind or other admitted semantic, the query returns an eligibility-coverage gap with affected count and amount and does not silently count, drop, or persist an unknown status. A supported integration that claims complete spending coverage must prove through fixtures that its declared scope has no such gap.

## 9. Taxonomy authoring and publishing

Keep one repository Taxonomy Package as the authoring source for each taxonomy version. It defines codes, parents, immutable semantics, applicability, localization keys, producer compatibility, and fixtures. CI must reject:

- duplicate codes, missing parents, or cycles;
- children that cannot safely aggregate to their parent;
- mutation or deletion of a published definition or parent;
- reuse of deprecated codes for new Assertions;
- missing localization;
- incompatible Kind/Category output;
- producer output not declared compatible with the installed package; and
- insufficient positive, negative, and boundary fixtures.

Generate transactional database seeds, TypeScript typed registries, validators, localization references, and shared fixtures from that one source. A Desktop Release seeds required definitions before opening the canonical writer. Taxonomy packages never update remotely. A semantic correction deprecates the old code and adds a new one; installing code never rewrites historical Assertions. Source or Derived reclassification requires a new evidence-backed contract or producer run. Existing User Assertions remain historically readable and may prompt the user to choose a current replacement; they are not mapped by label.

## 10. Acceptance checks

Implementation is acceptable only when automated tests prove:

1. every published Kind, Category, and Counterparty Role has a definition plus positive, negative, and boundary fixtures;
2. every integration crosswalk maps each supported source value uniquely, retains original value plus contract/crosswalk version in provenance, and cancels the Capture when a required Kind cannot resolve;
3. every allowed and disallowed Kind/Category combination is enforced for Source, Derived, and User paths;
4. allocations are exact, complete, atomic, currency-safe, and never expose a component before the whole set reconciles;
5. invoice-derived allocation requires reliable matching and exact reconciliation;
6. Counterparty References reuse only an exact producer-scoped key, names never merge, roles remain independent, and display selection is reproducible;
7. transaction override, reference alias, automatic display, and description fallback follow precedence without changing identity;
8. User, routed Source, and routed Derived categorization precedence and clearing fallback are reproducible at current and historical knowledge cutoffs;
9. low score, tie, failed run, partial run, complete withdrawal, and producer-route change follow the declared confidence and lifecycle rules;
10. single, allocated, and absent categorization are mutually exclusive, including refund/reversal inheritance and withdrawal;
11. Tags are user-only, independently withdrawable, renameable without identity change, and financially inert;
12. Unclassified totals and classification coverage include every financially admitted uncategorized amount without persisted status;
13. report eligibility gaps expose affected count and amount and prevent an incomplete total from being claimed complete;
14. financial inclusion remains unchanged under Category, Tag, alias, display, and note changes;
15. Current, Historical, and Lineage queries return typed taxonomy version, origin, selection, provenance, and dual-cutoff behavior without reading compact payloads in product code;
16. taxonomy CI prevents cycles, unsafe parents, definition mutation, code deletion, missing localization, incompatible applicability, and undeclared producer output;
17. taxonomy seeding and schema upgrade commit before the writer opens, while a failed upgrade exposes neither partial registry nor projection; and
18. no legacy categorization or enrichment data is migrated across the Canonical Reset established by ADR 0009.

## 11. Comparison references

- [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/) — comparison for versioned Personal Finance Categories, merchant/counterparty roles, entity identifiers, nullable merchant data, and enrichment confidence.
- [Plaid Investments API](https://plaid.com/docs/api/products/investments/) — comparison for investment operation coverage; Plaid sign and subtype conventions are deliberately decomposed rather than copied.
- [Plaid Personal Finance Category migration](https://plaid.com/docs/transactions/pfc-migration/) — comparison for taxonomy evolution and primary/detailed levels.
- [Taiwan DGBAS consumption classification](https://www.stat.gov.tw/public/data/dgbas03/bs4/ninews/9807/%E9%99%84%E8%A1%A84.pdf) — coverage check for Taiwan household-consumption purposes, not a direct canonical-code import.

## 12. Explicit first-version exclusions

This specification does not add Plaid connectivity, global merchant identity, fuzzy Counterparty merge, Institution/Counterparty merge, user merchant merge, user-created category trees, future merchant categorization rules, partial allocation, canonical `other`/`unknown`/`unclassified`, confidence candidates, cross-producer score ranking, enrichment-specific event storage, remote taxonomy updates, speculative merchant profiles, or legacy enrichment migration.
