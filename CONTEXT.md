# Octopus Beak

This context covers guided first-run setup and the financial automation needed to collect, import, and review a user's data.

## Language

### Desktop Release

**Desktop application release**:
A versioned, installable OctopusBeak desktop application distributed with the platform-specific installers needed by its supported operating systems. It is distinct from publishing a reusable project package.
_Avoid_: package release, source release

**Package publication**:
Publishing a reusable project package for installation as a dependency. It is outside the desktop application release flow.
_Avoid_: desktop release, installer release

**Release source**:
The protected source line whose selected version becomes the next desktop application release. Release version changes are written back to this source before packaging.
_Avoid_: feature branch, build branch

**Release target**:
A supported operating-system and CPU-architecture combination for which the desktop application produces a distributable artifact.
_Avoid_: package target, runtime platform

**Installable artifact**:
A distributable file produced for a release target and attached to the application release.
_Avoid_: package, source archive

**Immutable release version**:
A version that, once created for release, is never rewritten or replaced as part of normal recovery. Failed packaging or publication is repaired by retrying that same version.
_Avoid_: retry version, replacement version

**Release recovery**:
The operation that resumes packaging and GitHub Release publication for an existing immutable release version after a prior release run failed. It does not change the version or create another tag.
_Avoid_: rerun bump, rollback release

**Release preflight**:
The required verification of source integrity, dependencies, code, and runtime behavior before a new release version may be created. A failed preflight produces no release version.
_Avoid_: post-release check, installer smoke test

**Staged release**:
A release that temporarily holds generated notes and installable artifacts until the complete release target build succeeds. It is not formally published until the release gate passes.
_Avoid_: unpublished version, source draft

**Artifact integrity record**:
A digest record published with installable artifacts so a recipient can verify that each downloaded file is complete and unchanged.
_Avoid_: package integrity, source checksum

### Product

**Onboarding progression**:
The guided sequence that helps a person configure a credential source, collect statements, import them, and confirm the resulting overview. It begins after the person opts in from First-run Welcome or restarts it from Settings; it may pause for human assistance and resume later.
_Avoid_: First-run Welcome, welcome screens

**First-run Welcome**:
A one-time, resumable, swipe-through introduction shown before Onboarding progression for a genuinely empty new user. Existing product data or any existing Onboarding progression state identifies an existing user and bypasses it. First-run Welcome preserves the selected language and current slide across restarts, and completes only after the person explicitly chooses whether to begin bank automation; restarting onboarding from Settings never includes it.
_Avoid_: Welcome screens, onboarding intro

**Credential setup**:
The act of enabling a credential source, entering its credentials, and choosing the statement types required before collection.

**Sign-in details**:
The user-facing name for the identifiers, passwords, and related values a person supplies so a supported source can authenticate. They remain on the person's device; the Traditional Chinese UI calls them 「登入資料」, while certificate files remain certificates rather than sign-in details.
_Avoid_: Credentials, 憑證

**Sign-in identifier**:
A provider-specific, non-password value used to identify a person during authentication. Its user-facing name is defined by the supported source; current Taiwan bank and securities sources may identify it as a Taiwan ID number or online banking code, while future sources must not inherit that meaning automatically.
_Avoid_: Generic user ID, credential, authentication secret

**Statement selection**:
The set of statement types chosen for an enabled credential source to collect.

**Trusted financial overview**:
A reviewable, traceable view that unifies a person's imported cash, deposits, liabilities, investments, foreign currency, crypto assets, income, spending, and statement activity across supported sources. Analysis must preserve the distinction between verified data, known gaps, and user-supplied assumptions.
_Avoid_: Dashboard, portfolio view, financial summary

**Financial account**:
A persistent account identity established by one integration namespace, source connection, contract-defined stable account key, and identity epoch, used to organize that source scope's transactions, balances, liabilities, holdings, statements, and product terms. It persists across Captures and Import Runs within that scope but is never merged with an account from another integration or connection, even when both may represent the same real-world account.
_Avoid_: Cross-source account, display group, individual card

**Institution**:
The contract-established provider reference that maintains a Financial Account, such as a bank, broker, card issuer, fund platform, or crypto service. Its provider type is a technical taxonomy rather than a regulatory determination; an integration must map external provider identifiers uniquely before admission rather than creating provisional or conflicted Institution identity.
_Avoid_: Supported source, corporate-group brand, workflow provider code

**Institution source coverage**:
The many-to-many mapping that records which Institutions and products a supported source can collect or import. Coverage does not make a supported-source identifier the canonical identity of an Institution.
_Avoid_: Source connection, Institution identity, account ownership

**Financial account type**:
The required top-level classification `depository`, `credit`, `loan`, `investment`, or `other`; `depository`, `credit`, `loan`, and `investment` are all supported by current product paths. Every integration contract must resolve one value or cancel the attempted Source Capture, while an optional subtype is simply absent unless evidence supports it, such as `credit` with subtype `credit_card`.
_Avoid_: Product-specific table name, workflow label, unsupported inferred subtype

**Account identifier**:
A contract-defined stable source key used with integration namespace, source connection, and identity epoch to establish a Financial Account. Masks, labels, content hashes, and user input are not sufficient identity keys; an integration without a stable key fails admission rather than creating a provisional account.
_Avoid_: Cross-source reconciliation key, display label, content hash

**Account lifecycle fact**:
A source-supported activation, suspension, closure, or comparable operational state of a Financial Account that requires a contract-established effective time because it changes synchronization and historical financial scope. Absence from a Capture or a state lacking its effective time cannot establish a lifecycle revision and instead fails admission when the contract requires that fact.
_Avoid_: Account identity status, missing-account inference, collection-time closure

**Crypto financial account**:
An `investment` financial account with evidence-supported subtype `crypto_exchange` or `non_custodial_wallet`. Provider wallet labels create separate financial accounts only when the source establishes independent ledger, balance, transaction-scope, or wallet identity.
_Avoid_: Crypto holding observation, token, UI wallet label

**Holding observation**:
A source-reported quantity, cost, or valuation of a Security held in an investment financial account, recorded as a distinct evidence checkpoint only when its integration contract can establish when the measurement was financially effective. The current holding is a projection from the latest valid observation, while transaction history remains a separate event record.
_Avoid_: Investment transaction, mutable current holding, liability balance

**Crypto holding observation**:
A holding observation that references a Security classified as `cryptocurrency` within a crypto financial account. BTC, ETH, and similar assets are Securities held by the account rather than separate financial accounts; borrowing is not represented as a negative or liability holding.
_Avoid_: Crypto financial account, wallet, crypto loan

**Security**:
The Plaid-aligned canonical reference for an asset held in an investment financial account, classified by a security type such as equity, ETF, mutual fund, fixed income, derivative, cash, cryptocurrency, loan, or other. Classifying a cryptocurrency as a Security is a technical data-taxonomy choice and does not by itself assert that the asset is legally a security in Taiwan.
_Avoid_: Financial account, holding, legal securities determination

**Investment-account liability**:
An independently identifiable borrowing associated with investing is represented as a separate `credit` or `loan` financial account. Margin debt that the source reports only as part of an investment account, without independent account identity, remains a `margin_loan` balance observation on that investment account rather than becoming a liability holding or invented account.
_Avoid_: Liability holding, inferred loan account, negative Security

**Multi-currency financial account**:
A financial account whose transactions and balance observations may carry different currencies without being split into one canonical account per currency. An optional default currency never overrides the required currency of a transaction amount or balance observation; a currency subaccount is introduced only when the source explicitly establishes its identity.
_Avoid_: Account-per-currency, workflow currency folder, inferred currency subaccount

**Card instrument**:
A physical or virtual primary or supplementary card associated with a financial account. A different card number or mask does not by itself establish a separate financial account.
_Avoid_: Credit-card account, financial account

**Source connection**:
A persistent operational relationship through which a person authorizes or configures collection from a supported source and which namespaces the Financial Accounts it exposes. Accounts from different connections never share canonical identity; connection failure, replacement, disconnection, or deletion does not itself establish an account lifecycle fact, and authentication secrets remain outside the canonical model.
_Avoid_: Financial account, automation task run, credential secret

**Source sync state**:
Opaque continuation and health state scoped to a source connection, product stream, and optional financial account when required by the provider. A cursor is operational state rather than financial evidence and is advanced only according to the source protocol's complete-update rules.
_Avoid_: Financial transaction ID, source capture, global connection cursor

**Source capture**:
An immutable metadata envelope produced only after one source-side collection event passes its integration contract and sync admission checks, recording declared scope, observation time, completeness, contract version, and zero or more compact Source Records. An unsupported or indeterminate required value cancels the entire attempted capture and emits an operational error; retries or reprocessing of an accepted capture are operational runs rather than new captures.
_Avoid_: Import run, canonical financial account

**Source record**:
An immutable, compact evidence projection emitted by an integration within exactly one Source Capture, retaining the source identifiers, financial values, and provenance required for canonical mapping rather than a replayable file, response, or page. Repeated collection of an identical source claim may add provenance without duplicating its Canonical Assertion, while a newly discovered backfilled claim remains new knowledge even when its effective time is in the past.
_Avoid_: Canonical transaction, imported projection

**Canonical assertion**:
An append-only, provenance-bearing claim that a source, derivation, or person supports a value, identity, relationship, or lifecycle fact about a canonical subject. Assertions from different origin streams may coexist only after integration admission has produced a valid contract-defined value; current projections use declared precedence, and supersession occurs only within a continuous same-origin claim lineage.
_Avoid_: Mutable canonical field, source record, cross-origin overwrite

**Canonical admission boundary**:
The integration contract and sync preflight must resolve and validate every required candidate before it can become a Canonical Assertion; an indeterminate, unsupported, or mutually incompatible candidate cancels the attempted Source Capture, emits an operational error, and does not proceed into canonical storage or projection. Required canonical classifications never use `unknown`, while an unsupported optional fact is omitted rather than represented by an unknown assertion.
_Avoid_: Persisted conflict candidate, last-write-wins, silent fallback

**Source assertion**:
A Canonical Assertion for a fact explicitly supported by a Source Record, preserving the source evidence and its own lifecycle independently of parser interpretations or user corrections.
_Avoid_: Derived assertion, user assertion, imported projection

**Derived assertion**:
A Canonical Assertion produced by a parser, normalization, enrichment, or reconciliation rule from retained evidence, with its producer and rule version. A newer derivation may supersede an older one in the same claim lineage without claiming that the source evidence changed.
_Avoid_: Source fact, user correction, unversioned inference

**Derived assertion lifecycle**:
The append-only result of an atomic, successful, complete-scope Import Run for one producer, subject, field, and rule lineage: a changed supported value supersedes the prior Derived Assertion, an explicitly unsupported optional fact withdraws it, and an unchanged value only gains run provenance. Failed or partial runs change no assertions or projections, and one producer never supersedes another producer's lineage.
_Avoid_: Missing-output withdrawal, partial commit, cross-producer overwrite

**User assertion**:
A Canonical Assertion recording a person's explicit correction or choice for a user-governed field, including actor, decision time, and optional rationale. It may take precedence in the current projection or be withdrawn so projection falls back to the next valid assertion, but never rewrites or supersedes Source or Derived Assertions.
_Avoid_: Source correction, destructive override, silent preference

**User-governed field**:
A descriptive or organizational field such as display name, category, tag, or note for which the first version permits a User Assertion to control the current projection. Source financial amounts, dates, lifecycle states, balances, holdings, and Statement totals are not user-governed; suspected errors may be annotated but do not enter financial calculations as corrected facts.
_Avoid_: Source financial fact, statement selection, silent calculation override

**Entity field assertion**:
A Canonical Assertion about one descriptive or lifecycle field of a durable entity such as a Financial Account, Institution, or Security, allowing the current entity projection to combine independently sourced claims without whole-entity revision. A field change does not change canonical identity or relocate historical relationships.
_Avoid_: Whole-entity snapshot, identity remapping, mutable entity row

**Identity admission**:
The integration contract must establish one immutable source-scoped identity from integration namespace, source connection, stable source key, and identity epoch for every admitted source occurrence before a Source Capture is accepted. The first version provides no cross-source merge, split, relink, or Identity Correction capability; a contract later found wrong purges and recollects the affected scope rather than remapping it.
_Avoid_: Provisional identity, manual merge, silent account-id rewrite

**Identity epoch**:
A contract-declared fence within which stable source keys share one uniqueness scope, normalization, and subject meaning and may therefore continue a source-scoped identity across Captures. A new connection or any change to key scope, normalization, reuse rules, or identified subject starts a new epoch that never reconciles with the old one; non-identity parser, mapping, or enrichment changes only advance contract or rule version.
_Avoid_: Contract version, source revision, cross-epoch match

**Contract purge**:
The atomic hard deletion of all Captures and dependent Records, Assertions, revisions, relationships, and projections in an affected integration namespace, source connection, product stream, contract version, or identity epoch after an admitted contract is proven wrong. It is an exceptional replacement for correction lineage in the first version: only non-financial operational audit metadata remains, the old contract and epoch are disabled, and recovery requires recollection under a new version or epoch.
_Avoid_: Assertion withdrawal, partial row deletion, cross-source cascade

**Source authority routing**:
A contract-defined assignment of one authoritative integration, connection, and product stream to each projection input, preventing duplicate financial facts without merging source-scoped identities. Another source may serve a different stream, but no fuzzy or user-selected reconciliation moves facts between identities.
_Avoid_: Cross-source deduplication, identity merge, last-write-wins

**Account display group**:
A user-governed presentation grouping that may place multiple source-scoped Financial Accounts together without changing identity, relocating facts, deduplicating transactions, or authorizing their values for aggregation. It may be renamed or removed independently of all source evidence.
_Avoid_: Canonical account, reconciliation group, calculation authority

**Source assertion lifecycle**:
The append-only, provenance-bearing history `observed`, `revised`, `withdrawn`, and `restored` describing what a source asserts about a canonical projection. Only an explicit source tombstone or absence from a comparable contract-declared complete scope may withdraw a claim, and later reassertion of the same stable key may restore it; users cannot initiate either action, and neither action implies refund, reversal, cancellation, deletion, or Contract Purge.
_Avoid_: Economic transaction status, incomplete-scope absence, user withdrawal, contract purge

**Import run**:
A processing execution that reads Source Records and atomically produces or reconciles canonical projections under identified parser and rule versions. Initial required mapping failure cancels its attempted Source Capture; reprocessing an accepted Capture creates another run whose failed or partial output leaves existing Assertions unchanged, while a successful complete output may supersede or withdraw Derived Assertions but never creates source evidence, Source Assertions, or Observations.
_Avoid_: Source capture, financial event

**Evidence replay boundary**:
The first version can re-evaluate derivation and normalization only from fields retained in compact Source Records; it does not preserve raw artifacts or promise to replay extraction from historical files, responses, or pages. An extraction-contract change that needs discarded source content requires a new source collection and cannot retroactively reinterpret the old capture.
_Avoid_: Raw archive, artifact blob, full extraction reproducibility

**Canonical entity lineage**:
The required relationship from a canonical entity to the source records that support it. Direct source facts may inherit this relationship without duplicating provenance for every field.
_Avoid_: Import timestamp, source filename only

**Field provenance**:
The evidence and transformation metadata required for an inferred, normalized, or user-asserted canonical field, including its field path, value origin, supporting evidence, and applicable rule version. Confidence is recorded only when the derivation can support it.
_Avoid_: Entity lineage only, fabricated probability

**Canonical value origin**:
The classification `source_fact`, `parser_inference`, `normalized_projection`, or `user_assertion` that states how a canonical value was established. A user assertion coexists with source evidence and never rewrites an immutable source record.
_Avoid_: Verified boolean, importer name

**Balance observation**:
A balance measurement associated with a financial account and typed according to its actual meaning, such as ledger balance, available balance, credit limit, or amount due. It requires provenance plus contract-established effective, observation, and recording times so it can support historical valuation; a value derived from a transaction's balance-after field remains marked as derived and is not presented as a real-time provider balance.
_Avoid_: Current account field, transaction amount, assumed live balance

**Measurement history**:
The append-only sequence of Balance or Holding Observations created for distinct source-side measurement evidence with a contract-established effective time. Reprocessing the same Source Capture does not create another observation, while a measurement whose effective time cannot be established fails integration admission rather than entering history.
_Avoid_: Mutable current measurement, inferred effective date, transaction history

**Measurement effective time**:
The required financial time at which an integration's verified source contract says a Balance or Holding Observation applies, preserving the precision and time-zone semantics the contract can support. If the contract cannot determine it, the attempted Source Capture is cancelled; collection, recording, file, and import times never substitute for it.
_Avoid_: Observation time, recording time, parser guess

**Canonical temporal requirement**:
Each fact type declares effective time as required or not applicable rather than exposing a universally nullable field: Transactions, Statements, Balance and Holding Observations, and Account lifecycle facts require their contract-defined financial date or time, while purely descriptive names, labels, and notes use mandatory recording time without financial effective time. Missing required temporal evidence cancels the attempted Source Capture, and recording or observation time never fills it.
_Avoid_: Universal nullable effective-at, descriptive-field effective date, inferred timestamp

**Observation revision**:
An append-only correction lineage used only when an integration's verified source contract establishes that later evidence corrects the same source-side measurement. A new collection, a matching effective time, or reprocessing the same Source Capture is not by itself a revision; parser reinterpretation instead produces a versioned Derived Assertion.
_Avoid_: New observation, duplicate import, parser reinterpretation

**Financial transaction**:
A source-scoped canonical projection of a monetary event associated with a Financial Account, identified within one integration namespace, connection, product stream, stable source key, and identity epoch and traced to its Source Records. Occurrences from another integration or connection never share its identity; an integration unable to determine the key uniquely fails admission rather than creating a candidate or duplicate merge.
_Avoid_: Cross-source transaction, import record, statement line

**Transaction occurrence matching**:
The contract-defined reconciliation of repeated Source Record occurrences to one stable Financial Transaction identity within the same integration namespace, connection, product stream, and identity epoch. The mapping must be unique and versioned; a content hash or occurrence ordinal is evidence rather than a permanent key, and ambiguity cancels the attempted Capture.
_Avoid_: Cross-source match, content-hash identity, ambiguous merge

**Cross-source transaction separation**:
Financial Transactions from different integrations or source connections always retain separate identities, even when they appear to describe the same real-world event. Source authority routing prevents double use in projections; the first version performs no cross-source reconciliation, fuzzy deduplication, or user merge.
_Avoid_: Shared transaction identity, fuzzy auto-merge, user merge

**Transaction revision**:
An append-only canonical version created when strong source linkage establishes that changed evidence describes the same financial transaction. It preserves the stable financial-transaction identity, the prior revisions, supporting source records, and rule provenance; without strong linkage the changed record creates a separate transaction, while pending-to-posted remains a relation between two transactions rather than an ordinary revision.
_Avoid_: In-place transaction overwrite, guessed correction, pending-to-posted mutation

**Transaction amount**:
The required non-negative monetary magnitude actually booked to the financial account, paired with its required currency and an account-relative transaction direction. A currency inferred from an account or collection workflow remains explicitly marked with its provenance; a source record without a usable booked amount or currency is not promoted to a financial transaction.
_Avoid_: Signed cash flow, currency-free number

**Transaction currency**:
The required denomination of the account-booked transaction amount, established in order from an explicit source-row value, a currency-specific Source Capture scope, or a versioned fixed-currency Integration contract. A financial account's default currency is not transaction evidence, and a Source Record without traceable currency evidence remains outside the complete financial-transaction projection.
_Avoid_: Account default currency, display currency, unsupported currency guess

**Exact monetary value**:
A lossless decimal magnitude paired with an explicitly identified denomination; canonical amounts and rates never use binary floating point, while source formatting remains in the immutable Source Record and display rounding never changes the underlying value. Fiat denominations use ISO 4217, and any non-ISO denomination belongs to a distinct controlled scheme rather than masquerading as an ISO currency.
_Avoid_: Floating-point money, universal cents integer, formatted source text as calculation input

**Original transaction amount**:
An optional non-negative amount and currency in which a merchant, counterparty, or source originally denominated a financial transaction before conversion into the account-booked transaction amount. It preserves the source denomination but never replaces the amount used to reconcile the financial account.
_Avoid_: Canonical transaction amount, display-currency conversion

**Transaction conversion**:
Optional provenance-bearing conversion evidence connecting an original transaction amount to its account-booked transaction amount, with explicit base and quote currencies and a separate conversion date when known. A source-reported rate and a rate implied by the two amounts remain distinct and must pass a versioned rounding contract; inconsistent required evidence fails Capture admission, while an unsupported optional conversion is omitted rather than silently explained as a fee or filled from a later market rate.
_Avoid_: Bare exchange rate, current market conversion, inferred foreign fee

**Transaction direction**:
The required classification `inflow` or `outflow` describing money crossing the boundary of the financial account: deposits, refunds, and liability payments enter an account, while withdrawals, card purchases, and loan disbursements leave it. Every Supported Source Integration defines and tests one total, versioned mapping from its signs and debit/credit fields; a conflicting, indeterminate, or unsupported value cancels the attempted Source Capture.
_Avoid_: Amount sign, debit-or-credit column, unknown canonical direction, balance effect, net-worth effect

**Transaction effective date**:
The required local calendar date selected deterministically for ordering, period queries, and reporting, paired with a required basis of `occurred`, `authorized`, `posted`, `accounting`, or `inferred`. It selects the first available basis in that order after source fields have been mapped to their semantic roles; the underlying date observations remain separate, and a UTC storage anchor defaulted from a date-only value never claims that its local-midnight time was source reported.
_Avoid_: Import date, assumed midnight timestamp, only source date

**Transaction date observation**:
A provenance-bearing occurrence, authorization, posting, or accounting date/time for a financial transaction, retaining its source-local calendar value, precision, and time origin. Current Integrations normalize otherwise unzoned values with `Asia/Taipei`; a date-only value may use local midnight as a UTC storage anchor only when marked with `date` precision and `defaulted_local_midnight`, so the anchor is never presented as a source-reported event time.
_Avoid_: Exact timestamp for every date, system-timezone conversion, billing-statement date

**Transaction posting status**:
The required account-ledger booking classification `pending` or `posted`: pending evidence describes authorization, an expected entry, or a reserved amount not yet booked, while posted evidence establishes that the Institution recorded the entry in its account ledger. Each Supported Source Integration defines and tests a total, versioned mapping per Source Record kind; a missing, indeterminate, or unsupported source status is an integration contract error that cancels the attempted Source Capture rather than producing `unknown`, while billing, payment-network settlement, payment, refund, reversal, and source-removal semantics stay separate.
_Avoid_: Billing status, unbilled-as-pending, payment-network settlement, transaction kind, source removal

**Credit card transaction detail**:
An optional, non-independent extension of a financial transaction belonging to a `credit` / `credit_card` financial account. It holds evidence-supported credit-card specifics such as Card Instrument, optional `unbilled | billed` billing status, Billing Statement membership, original-currency and FX data, installment detail, and source payment status without acquiring a separate identity or lifecycle; unsupported optional facts are absent rather than `unknown`.
_Avoid_: Credit card transaction entity, statement line, financial transaction

**Transaction relation**:
An optional, provenance-bearing relationship between two source-scoped Financial Transactions, initially typed as `pending_to_posted`, `refund_of`, `reversal_of`, `transfer_counterpart`, or `installment_of`, created only from explicit source evidence or a validated uniquely deterministic integration contract. Users cannot establish financial relations; unsupported optional relations are absent, and admitted relations never merge or delete transactions, impose a global one-to-one constraint, or invent amount allocations.
_Avoid_: Transaction identity merge, user financial assertion, ambiguous match

**Pending-to-posted transaction relation**:
A directed `pending_to_posted` Transaction Relation from a separate pending Financial Transaction to its posted Financial Transaction when explicit source linkage or a validated, versioned source-specific contract establishes the pairing. Each transaction retains its identity and evidence, an unmatched pending transaction remains independent, and similarity alone establishes no relation, revision, merge, or reason to delete the pending transaction.
_Avoid_: Pending-to-posted mutation, transaction revision, fuzzy confirmed relation, pending deletion

**Transaction refund relation**:
A `refund_of` Transaction Relation from a separately booked return of value to an earlier Financial Transaction that remains an economic event. A refund may be partial, and multiple refunds may refer to the same original transaction; similar descriptions, opposite directions, equal amounts, or nearby dates alone establish no relation.
_Avoid_: Reversal, cancellation, original-transaction deletion, fuzzy confirmed relation

**Transaction reversal relation**:
A `reversal_of` Transaction Relation from a separately booked compensating transaction to the Financial Transaction whose economic effect it corrects or voids. It is distinct from a refund because the original event is being undone rather than followed by a later return of value; source wording or amount-and-date similarity alone establishes no relation.
_Avoid_: Refund, cancellation, source withdrawal, fuzzy confirmed relation

**Transfer-counterpart transaction relation**:
A semantically symmetric `transfer_counterpart` Transaction Relation connecting the separate account-side Financial Transactions of one movement between Financial Accounts, never merging them or treating physical endpoint ordering as money direction. A pair involving a `credit / credit_card` account is interpreted as a credit-card payment from account types and transaction directions rather than a separate relation type; a source-reported payment with no observed other side remains a source fact.
_Avoid_: Cross-account transaction merge, transfer deduplication, credit-card-payment relation type, inferred missing counterpart

**Installment transaction relation**:
A directed `installment_of` Transaction Relation from a Financial Transaction representing an installment to an evidence-backed original Financial Transaction. A source-reported installment sequence or plan detail without an observed original transaction remains Credit Card Transaction Detail rather than causing OctopusBeak to invent the missing transaction or relation.
_Avoid_: Inferred original transaction, installment-plan entity without evidence, relation from sequence text alone

**Transaction removal**:
A source-sync assertion that a previously projected transaction is no longer present in that source's current result. It is not evidence by itself of a refund, reversal, or cancellation of the underlying monetary event.
_Avoid_: Refund, reversal, deleted source record

**Transaction cancellation**:
An explicitly source-reported outcome that a pending authorization or other unposted transaction will not proceed to posting. In the first canonical model it remains a provenance-bearing source fact rather than a posting status or Transaction Relation; disappearance, withdrawal, or a missing posted counterpart never establishes cancellation, while a separately booked compensating movement is evaluated as a refund or reversal.
_Avoid_: Source withdrawal, cancelled posting status, inferred cancellation, refund, reversal

**Credit card billing statement**:
An evidence-gated, settled billing-cycle summary for a credit-card financial account, created only when an integration's verified contract can establish its source identity and settled billing-cycle semantics. Its period, issue and due dates, totals, minimum payment, and transaction membership belong to the Statement rather than becoming transaction date observations; ambiguous same-period candidates are excluded by the integration rather than admitted for canonical conflict resolution.
_Avoid_: Unbilled transaction list, transaction date, transaction export, source capture

**Statement revision**:
An append-only correction lineage created only when an integration's verified contract proves that the source reissued or corrected the same Statement through stable identity, revision, or replacement semantics. A different billing cycle creates a new Statement, and the first version does not allow a User Assertion to choose between ambiguous Statement candidates.
_Avoid_: New billing cycle, same-period guess, user-selected source revision

**Statement document**:
A provider-issued statement file, such as an official PDF, retained as a source record rather than treated as a canonical billing statement by its file form alone.
_Avoid_: Credit card billing statement, CSV transaction export

**Local-first AI financial assistant**:
An assistant that lets a person use a locally available language model to explore their trusted financial overview, learn from it, and assess trends and risks with traceable external information. Product and technical boundaries—including privacy, model providers, advice, and external-information handling—are defined by an implementation-ready specification before build work begins.
_Avoid_: Cloud financial advisor, autonomous investment manager

**Personalized financial decision support**:
Evidence-backed explanation, scenario comparison, and risk identification based on a person's trusted financial overview. An unlicensed product limits this to general education, descriptive analysis, and user-directed simulations; actionable recommendations about individual securities or portfolio changes require a licensed investment-advisory route or accountable licensed partnership. It distinguishes sourced facts, model inference, uncertainty, and suggestions, and never executes trades or presents a buy-or-sell conclusion as certain.
_Avoid_: Automated investment advice, autonomous portfolio management

**Unlicensed general financial decision support**:
The first-release product route that provides financial facts, descriptive risk analysis, general education, and user-directed simulations without selecting or recommending an action on an individual security or portfolio. Licensed investment advice or an accountable licensed partnership is a later, separate product stage.
_Avoid_: Unlicensed investment advice, robo-advisor lite

**User-defined financial policy**:
A threshold, target, constraint, or scenario assumption explicitly chosen by the person. The system may calculate and explain deviations from it, but does not choose the policy, convert a simulation into an instruction, or treat a general educational benchmark as the person's target.
_Avoid_: AI-recommended allocation, inferred investment policy

**Financially neutral product revenue**:
First-release software purchase or subscription revenue that is not linked to a financial product, issuer, referral, transaction, asset ranking, or model output. Sponsored placement, transaction-linked compensation, issuer commissions, and paid product promotion are excluded.
_Avoid_: Financial-product monetization, recommendation revenue

**Paid operational value**:
The time and maintenance burden removed by reliable collection automation, model catalog management, maintained external-data access, and scheduled risk monitoring. Financial analysis and conversation are core product capabilities; payment is for dependable ongoing operations, not for a particular investment answer.
_Avoid_: Paid investment answer, advice subscription

**Fact clarification**:
A free capability that helps a person inspect, question, and understand traceable financial facts, calculations, data gaps, and evidence without turning them into an investment instruction.
_Avoid_: Financial recommendation, portfolio diagnosis

**Intent clarification**:
A free conversation that helps a person articulate and restate their own goals, constraints, time horizon, and risk concerns. The assistant does not select a goal, infer a financial policy, or translate the clarified intent into a security trade or portfolio instruction.
_Avoid_: AI-selected goal, inferred risk profile

**Licensed advice stage gate**:
The separate product stage required before any actionable personalized recommendation about an individual security or portfolio may be offered. It requires written Taiwan regulatory counsel review of actual product outputs, an investment-advisory licence or accountable licensed service provider, and the applicable suitability, disclosure, contract, complaint, recordkeeping, and algorithm-governance controls.
_Avoid_: Advice feature flag, disclaimer-based approval

**Local financial data boundary**:
The privacy boundary under which financial accounts, identifiers, transactions, and positions remain on the person's device and may be observed by an authorized local agent when relevant. Authentication secrets are never placed in agent context. Open-weight models process financial data locally; external information is brought onto the device, while outbound discovery queries are minimized and de-identified. Any future cloud-model mode is separately enabled and discloses the data sent for each use.
_Avoid_: Local-only product, anonymous financial data

**Authentication secret**:
A login password, one-time code, session token, cookie, API key, credential answer, or equivalent material that can authenticate as the person. It is never exposed to a model or agent tool, even when other financial data is locally observable.
_Avoid_: Financial account identifier, account data

**Authentication certificate file**:
A user-owned certificate file selected for a supported source's authentication flow. The application retains a reference to the original file without copying it, presents only its filename in ordinary UI, and treats its password separately as an authentication secret.
_Avoid_: Sign-in detail, copied certificate, uploaded certificate

**Financial context pack**:
A broad, local view of the trusted financial overview supplied so an agent can understand the person's overall situation. The agent may use authorized tools to inspect any additional non-secret financial detail relevant to a new analytical angle; authentication secrets remain excluded.
_Avoid_: Full credential context, fixed dashboard payload

**External local provider trust**:
The lower trust assigned to a separately installed local model daemon whose version, logs, updates, and model sources are not controlled by the product. It receives financial data only after explicit enablement and disclosure, only over an eligible loopback endpoint, and never receives authentication secrets.
_Avoid_: Built-in provider trust, local-equals-trusted

**Active local generation model**:
The single local model currently allowed to generate responses for the application. Switching may release the previous model and its cache from memory, but does not remove its installed artifact from storage.
_Avoid_: Installed model, downloaded model

**Installed model artifact**:
A model file retained in local storage until the person explicitly removes it. Runtime memory release, provider failure, catalog retirement, application restart, and model switching do not delete the artifact or require it to be downloaded again.
_Avoid_: Loaded model, active model

**Model catalog**:
The product-curated index of candidate, verified, deprecated, revoked, and system-provided models, including their provenance, integrity, licensing, device-fit, and lifecycle records. Membership means the model is visible and governed by the catalog; it does not by itself claim verified behavioral quality.
_Avoid_: Verified model catalog, open model registry

**Verified model artifact**:
An exact, immutable model artifact that has passed every first-release conversation, financial explanation, tool use, evidence synthesis, risk reasoning, context, safety, licensing, integrity, and runtime-compatibility gate. Verification promises complete first-release capability and belongs only to that artifact and evaluation version, not to its model family, provider, another quantization, or an externally managed copy.
_Avoid_: Verified model family, approved brand

**Catalog recommendation**:
A contextual label applied to an activatable catalog model for a particular device and user preference. It is recalculated from current evidence rather than treated as a permanent model rank or a claim of verification.
_Avoid_: Best model, universal default

**Catalog candidate**:
An exact model artifact that has passed the activation safety floor but not the complete first-release capability evaluation. It may use every first-release assistant capability after a one-time disclosure; the status limits the product's quality claim, not the model's functional access.
_Avoid_: Verified model, unsupported model

**Model activation safety floor**:
The deterministic provenance, integrity, format, runtime, host-authority, credential-boundary, and device-preflight checks required before a model artifact may be activated. It verifies App-controlled boundaries rather than model intentions and makes no claim about the model's behavioral safety or financial-assistant quality.
_Avoid_: Full model verification, quality benchmark

**Model verification record**:
A product-published record that binds an artifact hash and evaluation version to the results of the fixed complete-capability process. The first-release app consumes and presents signed records; it does not reproduce the full evaluation or grant verification from user-device results.
_Avoid_: Device benchmark result, community rating

**Catalog retirement**:
The catalog transition that stops recommending a deprecated model artifact while leaving it activatable, or prevents loading a revoked artifact because integrity, security, or licensing requires it. Retirement never deletes an installed artifact; storage removal remains the person's decision.
_Avoid_: Model deletion, automatic uninstall

**Evidence-backed current information**:
Time-sensitive market, policy, and international-event information retrieved for the current analysis with visible source, publication time, and retrieval time. Primary sources take precedence; conflicts, staleness, and missing corroboration reduce confidence or prevent a conclusion. Model training memory is not current evidence.
_Avoid_: Model knowledge, latest information

**Traceable financial computation**:
A deterministic calculation of balances, returns, allocation, cash flow, concentration, or exposure whose method and source records can be inspected. Language models may request and explain these results but do not calculate, overwrite, or become the source of financial facts.
_Avoid_: AI-calculated balance, model-derived financial fact

**Local analysis lineage**:
The on-device record needed to reproduce and inspect an analysis: financial-data snapshot time, deterministic calculation and rule versions, external-source timestamps, model and policy versions, answer or refusal, and user corrections. The person can inspect, export, and delete it; provider diagnostics exclude raw assets, transactions, positions, and complete conversations unless separately and explicitly authorized.
_Avoid_: Cloud conversation history, provider financial log

**Transparent model fallback**:
A pre-authorized switch away from the person's selected primary model only when it is unavailable, unfit for the requested capability, or prohibited by a safety gate. The product identifies the actual provider and model, explains the switch, and discloses what conversation context is transferred; it never silently substitutes an unverified model.
_Avoid_: Automatic model substitution, invisible routing

**Authorized tool request**:
A model-proposed request that the host validates against an allowlist, schema, permissions, sensitivity rules, and resource limits before any tool runs. Models and provider adapters hold no direct ledger, filesystem, network, shell, or application authority; rejected requests remain visible in local analysis lineage.
_Avoid_: Model-executed tool, provider permission

**User-directed source retrieval**:
Retrieval of a URL explicitly supplied or selected by the person, performed by the evidence layer without browser identity, financial context, or provider network authority. Retrieved content remains untrusted, is cleaned and provenance-recorded, and does not authorize following additional links or executing embedded instructions.
_Avoid_: Model web browsing, authenticated browser handoff

**Core user**:
A person in Taiwan who manages at least three bank, credit-card, or investment accounts and is tired of consolidating them manually in spreadsheets. This is the initial audience, not a permanent limit on who OctopusBeak may serve.
_Avoid_: macOS user, all personal-finance users

**Supported source**:
A collection and import integration whose declared Institution and product coverage has been verified for the current Beta. A planned, previously working, or merely registered integration is not a supported source.
_Avoid_: Institution, supported bank, available integration

**Supported source name**:
The formal user-facing name of a supported source. In the Traditional Chinese UI, a distinct localized name is followed by its English name in parentheses; brand names without a distinct translation remain unchanged.
_Avoid_: Workflow label, provider code, integration ID

**Source setup guide**:
An always-expanded, source-specific section in credential setup that explains what sign-in details to prepare, the setup steps, and allowlisted official service links. Its copy and links ship with the application instead of loading remotely; detailed certificate-component or API instructions appear here as additional guidance rather than field-level hints.
_Avoid_: Field hint, remote help content, generic learn-more link

**Statement run summary**:
A compact record of one automation task run's statement collection outcome, including each selected statement type's result and the overall outcome.

**External prerequisite**:
A locally installed or user-controlled dependency outside the app that must be available before an automation task can authenticate or collect data, such as a security component, browser extension, or certificate component.
_Avoid_: Credential, workflow error, generic setup

**External prerequisite recovery**:
The user-assisted sequence that restores an unavailable external prerequisite and then makes the affected automation task ready to run again.
_Avoid_: Manual login, automatic retry

**External prerequisite recovery notice**:
A persistent in-app notice attached to a failed automation task run when an external prerequisite can be restored; the affected task supplies the official download link, and the notice directs the person to run the task again after recovery. One notice exists per task and prerequisite, is updated rather than duplicated on repeated failures, and clears only after a successful retry.
_Avoid_: Toast, generic failure alert, OS notification

**External prerequisite signal**:
A structured workflow result that identifies a recoverable external prerequisite instead of requiring the automation server to infer it from an error string.
_Avoid_: Error-text classification, generic failure

**Automation session finalization**:
The act of relinquishing an owned automation session after a run, including graceful close, daemon teardown when needed, and removal of the session's ownership record.
_Avoid_: Session close (which names only the graceful close operation).

**Automation task**:
A reusable scheduled unit that can be started manually, in a batch, or as a resume.

**Automation task run**:
One persisted execution attempt of an automation task, including its output, status, and any retained session. A run waiting for human input remains that run; resuming creates a new run for the subsequent outcome.

**Automation task run finalization**:
The act of deciding an automation task run's terminal outcome, recording its result, and relinquishing or retaining its automation session.

**Automation task run finalization intent**:
The stated outcome and session disposition that guide how an automation task run is finalized.

**Automation session disposition**:
The decision to retain an automation session for human assistance or relinquish it after a task run.

**Automation task run force-quit**:
An operator-initiated action that ends a task run waiting for human input by relinquishing its exact automation session and finalizing the run as failed.

**Human verification target**:
A workflow-declared browser control or verification modal area that a person may interact with during an automation session. Each target has a workflow-owned semantic identity and current geometry for presentation and coordinate mapping. Assist permits interaction only with declared targets; unrelated viewer regions do not open a floating input and do not count as completed human assistance.
_Avoid_: Generic editable target, nearest input target

**Verification completion**:
The condition that permits an automation task to resume after human assistance. For an independent verification flow, completion requires confirmation from the workflow or host; for inline verification submitted together with login information, the available pre-submit condition is that the declared verification field is non-empty, while login success remains the final correctness check.
_Avoid_: Input has value means verification succeeded

**Verification focus view**:
A zoomed Assist presentation centered on the declared human verification target while preserving the challenge instructions, image, and surrounding context needed to solve it. A person may pan or zoom the presentation to inspect the full challenge context, but viewport manipulation is not a browser operation and only declared targets remain actionable.
_Avoid_: Full-page Assist, arbitrary zoom

**Verification context region**:
A workflow-declared visual region that must remain visible in the verification focus view so a person has the instructions, challenge, and surrounding evidence needed to complete a human verification target. The region may be visible without being actionable.
_Avoid_: Whole-page context, inferred nearest region

**Human assistance contract**:
A structured, persisted description emitted by a workflow when an automation task waits for human assistance. It declares the actionable human verification targets, the verification context regions that must remain visible, and the completion condition that governs resumption. The automation server and task-run persistence are its sole source of truth; the workflow emits structured updates and Assist only reads and presents them. A single task run may publish versioned contract updates as the verification flow changes; the contract ends when the workflow succeeds, fails, or is force-quit. Assist consumes this contract rather than inferring interaction rules from screenshots, DOM proximity, or log text.
_Avoid_: Screenshot-derived affordance, log-derived interaction contract

**Human interaction stage**:
A versioned phase of a human assistance contract with a finite allowlist of actionable targets. A stage may expose multiple explicitly declared controls within one verification modal, but controls outside the stage remain unavailable; completion transitions the task run to the next contract version or out of human assistance.
_Avoid_: Full viewer stage, unrestricted page interaction

**Verification interaction mode**:
The operation explicitly permitted for a human verification target, such as click, type, or drag. The automation server rejects operations that the current target has not declared, even if the underlying browser control could technically receive them.
_Avoid_: Generic viewer capability, inferred operation

**Human verification retry**:
The continuation of a resumed automation task run that discovers the human verification is incomplete or incorrect. The run returns to waiting for human assistance with refreshed challenge context and a new contract version, preserving the task's execution lineage instead of immediately becoming terminally failed. Retries are bounded by the workflow or external verification service; the app never retries indefinitely, and an exhausted or locked verification becomes an explicit task failure.
_Avoid_: Restarting the whole workflow, treating an incorrect answer as an ordinary infrastructure failure

**Human assistance contract resolution failure**:
A state in which the current semantic target or verification context region cannot be resolved against the live browser session. Assist remains waiting with Resume disabled, does not fall back to unrestricted page interaction, and exits only after a contract update or an explicit force-quit.
_Avoid_: Nearest-element fallback, silent target substitution

**Human verification target accessibility**:
The keyboard and pointer operation paths a declared human verification target makes available. Type targets receive focus, click targets expose equivalent keyboard activation where possible, and pointer-only drag targets require an explicit workflow declaration and user guidance.
_Avoid_: Pointer-only by accident, keyboard bypass of target rules

**Human assistance contract freshness**:
The requirement that every human interaction carries the current task run's contract version. The automation server rejects operations from a stale stage after navigation, modal changes, or contract updates, and Assist must reload the current contract before presenting another actionable target.
_Avoid_: Stale-coordinate interaction, client-only stage tracking

**Human verification input privacy**:
The boundary that keeps raw text entered into human verification targets out of the human assistance contract, task logs, and analytics. CAPTCHA, OTP, password, and other authentication material is forwarded only to the live CDP session; persisted records retain target, operation, outcome, and timing metadata without reconstructing the input.
_Avoid_: Logged verification text, replayable input screenshot

**Human verification screenshot privacy**:
The rule that challenge screenshots and verification focus views exist only in the active Assist session's memory. They are cleared when Assist closes or the browser session ends, and are never persisted in task records, logs, analytics, or user-accessible exports.
_Avoid_: Diagnostic screenshot archive, persisted challenge image

**Legacy human assistance run**:
An existing task run waiting for human input without a persisted human assistance contract. Assist does not infer its interaction rules from historical logs or expose an unrestricted viewer; it presents recovery guidance and requires force-quit followed by a new workflow run that can publish a contract.
_Avoid_: Log-based compatibility mode, unrestricted legacy Assist

**Human assistance contract API**:
The shared host boundary through which a workflow creates or updates a human assistance contract. It owns persistence, task-run association, versioning, and fail-safe validation; provider workflows supply only their verification-specific targets, context regions, interaction modes, and completion rules.
_Avoid_: Raw pause log, provider-specific persistence, UI-owned contract state

**Provider verification adapter**:
A provider-owned resolver and completion adapter that identifies the live verification controls, frames, challenge regions, allowed interaction modes, and provider-specific completion signals for a human assistance contract. The generic viewer does not infer these details from arbitrary page inputs.
_Avoid_: Generic input scanner, nearest-control heuristic

**Onboarding human verification gate**:
The rule that onboarding progression is driven by the real automation task outcome, not by local Assist interaction state. Entered text or a completed UI interaction may make Resume available according to the contract, but onboarding remains in Assist until the workflow reports successful collection.
_Avoid_: UI-interaction onboarding advance, input-nonempty milestone
