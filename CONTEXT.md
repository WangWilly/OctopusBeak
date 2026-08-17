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

**Collection scope version**:
A sanitized version of the enabled product streams, Statement Selections, identity scope, query coverage, completeness semantics, and other non-secret Integration configuration that determines what one Source Capture means. A collection attempt records and revalidates this version before admission; authentication-secret rotation and purely presentational or scheduling changes do not create financial knowledge or change it.
_Avoid_: Credential version, UI settings version, Capture contract version, secret fingerprint

**Trusted financial overview**:
A reviewable, traceable view that unifies a person's imported cash, deposits, liabilities, investments, foreign currency, crypto assets, income, spending, and statement activity across supported sources. Analysis must preserve the distinction between verified data, known gaps, and user-supplied assumptions.
_Avoid_: Dashboard, portfolio view, financial summary

**Financial account**:
A persistent account identity established by one integration namespace, source connection, contract-defined stable account key, and identity epoch, used to organize that source scope's transactions, balances, liabilities, holdings, statements, and product terms. It persists across Captures and Import Runs within that scope but is never merged with an account from another integration or connection, even when both may represent the same real-world account.
_Avoid_: Cross-source account, display group, individual card

**Canonical local identifier**:
An opaque durable reference assigned independently of account numbers, card keys, provider identifiers, content hashes, display values, and other business fields. It names an already admitted canonical object but does not prove uniqueness or identity continuity, which remain enforced by the object's contract-defined source scope and stable-key constraints.
_Avoid_: Business-key identifier, deterministic content hash, identity evidence, display ID

**Canonical identity invariant**:
A contract-established source scope, stable key meaning, and identified subject property whose change means the prior identity contract was wrong or a new Identity Epoch has begun, rather than an ordinary field revision. Optional subtype, display metadata, lifecycle state, and financial measurements are not identity invariants merely because they appeared when the entity was first admitted.
_Avoid_: Mutable entity field, optional classification, display label, current financial state

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
A contract-defined stable source key used with integration namespace, source connection, and identity epoch to establish a Financial Account. It may be a provider account identifier or a contract constant only when the integration proves that the connection scope contains exactly one account of that kind; masks, labels, content hashes, card keys, and user input are not sufficient identity keys, and an integration without a stable account scope fails admission rather than creating a provisional account.
_Avoid_: Cross-source reconciliation key, display label, content hash

**Credit-card financial account**:
A `credit` Financial Account representing one issuer-managed primary-cardholder credit and billing portfolio within a source connection, under which multiple primary, supplementary, virtual, replacement, or renewed Card Instruments may generate transactions and statements. A card number, mask, product name, or billing cycle never establishes a separate account by itself; the integration must provide an account-level key or prove a single-primary-portfolio connection scope before it may use a fixed contract key.
_Avoid_: Individual card, masked PAN account, issuer-wide merge across connections

**Primary-cardholder portfolio scope**:
A source contract guarantee that one source connection and credit-card product stream exposes exactly one primary cardholder's issuer-managed credit and billing portfolio, allowing a fixed account key within that connection while retaining all cards as subordinate instruments. A login, a list of cards, shared dates, or the authenticated person's identity does not establish this guarantee unless the provider page semantics and integration fixtures verify the primary-account scope; supplementary-only or mixed-primary scopes fail admission.
_Avoid_: Logged-in-user assumption, all-cards-at-bank merge, card-list account inference

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
Opaque committed continuation and health state scoped to a source connection, product stream, and optional financial account when required by the provider. A cursor is operational state rather than financial evidence and advances in the same Canonical Financial Commit as the complete accepted Capture it covers; an integration whose source contract has no continuation state leaves it absent rather than inventing a collection-time watermark.
_Avoid_: Financial transaction ID, source capture, global connection cursor

**Sync attempt checkpoint**:
Disposable transport progress for resuming an incomplete collection attempt, such as a downloaded page or temporary continuation token. It never advances committed Source Sync State, establishes a Source Capture, enters historical queries, or authorizes partial financial facts, and may be discarded when the attempt succeeds, fails, or expires.
_Avoid_: Committed cursor, partial Capture, financial evidence, canonical checkpoint

**Source capture**:
An immutable metadata envelope produced only after one source-side collection event passes its integration contract and sync admission checks, recording observation time, contract version, one or more typed Capture Scopes, and zero or more compact Source Records. An unsupported or indeterminate required value cancels the entire attempted capture and emits an operational error; retries or reprocessing of an accepted capture are operational runs rather than new captures.
_Avoid_: Import run, canonical financial account

**Capture scope**:
A typed, queryable declaration of the source subject, product stream, optional financial-time range, and contract-proven completeness covered by one Source Capture. Only the integration contract may establish complete-snapshot, complete-range, or incremental semantics; an empty result or absent next page does not establish completeness by itself. Absence may withdraw prior source support only within comparable scopes whose completeness is proven, while integration-specific supplementary metadata may remain in the compact Source Record payload but cannot authorize withdrawal.
_Avoid_: Best-effort completeness, payload-only scope, empty-result withdrawal, transport page

**Source record**:
An immutable, compact evidence projection emitted by an integration within exactly one Source Capture, consisting of a common identity and provenance envelope plus a contract-versioned record-kind payload containing only the source identifiers and financial values required for canonical mapping. It is not a replayable file, response, or page; product calculations consume typed canonical facts rather than its integration-specific payload. Repeated collection of an identical source claim may add provenance without duplicating its Canonical Assertion, while a newly discovered backfilled claim remains new knowledge even when its effective time is in the past.
_Avoid_: Canonical transaction, imported projection

**Canonical assertion**:
An append-only, provenance-bearing claim that a source, derivation, or person supports exactly one explicitly typed canonical revision, relation, observation, identity, or governed field. Assertions from different origin streams may coexist only after integration admission has produced a valid contract-defined value; current projections use declared precedence, and supersession occurs only within a continuous same-origin claim lineage.
_Avoid_: Mutable canonical field, source record, cross-origin overwrite

**Assertion lifecycle transition**:
An append-only, knowledge-time event that observes, supersedes, withdraws, or restores support within one continuous, origin-specific Assertion lineage without mutating its prior Assertions or typed financial revisions. Repeated evidence for an unchanged claim adds provenance rather than another value revision; transitions never represent transaction cancellation, refund, reversal, deletion, or a cross-origin overwrite.
_Avoid_: Mutable assertion status, financial event, duplicate unchanged assertion, conflict resolution

**Canonical admission boundary**:
The integration contract and sync preflight must resolve and validate every required candidate before it can become a Canonical Assertion; an indeterminate, unsupported, or mutually incompatible candidate cancels the attempted Source Capture, emits an operational error, and does not proceed into canonical storage or projection. Required canonical classifications never use `unknown`, while an unsupported optional fact is omitted rather than represented by an unknown assertion.
_Avoid_: Persisted conflict candidate, last-write-wins, silent fallback

**Canonical financial commit**:
The indivisible visibility boundary that admits one complete Source Capture and makes its Source Records, canonical identities and facts, Assertion lineage, and affected current projections durable together. A failed admission, processing run, or Contract Purge exposes none of its partial financial effects; Sign-in Details, Integration configuration, and non-financial preferences are operational state outside this boundary.
_Avoid_: Partial Capture commit, eventually consistent projection, cross-store financial write

**Canonical knowledge point**:
The single recorded knowledge position shared by every fact, Assertion transition, provenance link, and projection change in one Canonical Financial Commit. Knowledge points have a strict local order independent of wall-clock ties or reversal; backfilled financial facts retain the later knowledge point at which they were admitted rather than being backdated to their effective time.
_Avoid_: Per-row import time, financial effective time, wall-clock-only ordering, backdated knowledge

**Current financial projection**:
The deterministic, disposable selection of the presently authoritative canonical revisions, Observations, Statements, and user-governed fields under declared Assertion precedence and Source Authority Routing. It becomes visible in the same Canonical Financial Commit as the facts that change it, contains no independent financial authority, and can be rebuilt completely from the immutable write model. A projection-rule change builds and validates one complete replacement while the prior projection remains readable, then switches atomically so consumers never observe a mixed generation.
_Avoid_: Mutable source of truth, runtime consumer interpretation, eventually consistent read model

**Historical financial projection**:
A query-time reconstruction from immutable canonical facts and Assertion lifecycle using an explicit financial-time cutoff, knowledge-time cutoff, or both. Backfilled facts participate according to their effective time but remain absent from knowledge-time views before their `recorded_at`; precomputed daily snapshots never replace this dual-time history.
_Avoid_: Current projection snapshot, import-time history, backdated knowledge

**Canonical query boundary**:
The exclusive read boundary through which product consumers request a Current Financial Projection, a cutoff-qualified Historical Financial Projection, or Lineage Inspection. Consumers never select Assertion precedence, Source Authority Routing, latest Observations, lifecycle effects, or integration-specific Source Record payloads independently, and missing canonical data never falls back to legacy or product-specific financial rows.
_Avoid_: Direct write-model query, consumer-specific precedence, source-payload calculation, product fallback

**Canonical reset cutover**:
A version-triggered, one-time breaking replacement that automatically starts a new empty canonical financial store instead of migrating or reading any legacy financial, Source Capture, Source Record, assertion, projection, override, classification, import-run, or automation-run history. Startup completes the cutover only after it has atomically quarantined legacy data, copied Preserved Operational Configuration, and created and validated the empty store; failure leaves legacy files unchanged and refuses to open a partial store rather than falling back to the legacy model. The completed cutover creates new Source Connections, Identity Epochs, Captures, and canonical facts only through integration contracts that satisfy the current model. Legacy ledger and download files never participate in canonical reads, fallback, replay, or recollection; their physical retention or destruction follows Legacy Data Quarantine.
_Avoid_: Legacy migration, compatibility backfill, dual read, legacy fallback, partial history carry-forward

**Preserved operational configuration**:
The non-financial local state carried across a Canonical Reset Cutover: Sign-in Details, enabled-integration configuration, Statement Selections, and user-interface preferences that neither assert a financial fact nor identify a canonical Financial Account. Preserving it authorizes future collection but never preserves Source Connection identity, Source Sync State, Captures, provenance, user financial classifications, or other financial history.
_Avoid_: Migrated financial state, preserved canonical identity, retained sync cursor

**Legacy data quarantine**:
The temporary, read-disabled retention of the pre-cutover ledger and downloads outside every application lookup, import, replay, fallback, and recovery path. It provides no user-facing restore mode. The release after the Canonical Reset Cutover automatically destroys the quarantine only when a durable local marker proves that the cutover completed, the canonical store opened successfully, at least one contract-compliant recollection completed, and no canonical application path ever read the quarantined files; otherwise it leaves the quarantine unchanged for a later release. Quarantine never makes legacy data part of the supported model.
_Avoid_: Legacy fallback, migration input, application-readable archive, indefinite compatibility storage

**Canonical recollection readiness gate**:
The release prerequisite that every enabled integration configuration preserved by a Canonical Reset Cutover, and every integration the release continues to advertise as supported, has a versioned, fixture-tested contract that resolves all required identity, classification, status, and effective-time semantics of the current canonical model. One unready supported integration blocks the breaking-change release; the gate evaluates new collection behavior only and never requires legacy data migration or parity.
_Avoid_: Post-reset disabled surprise, partial integration rollout, legacy migration readiness, best-effort contract

**Post-reset recollection**:
The normal per-integration synchronization that repopulates an empty canonical store after a Canonical Reset Cutover. It begins only after the local cutover commits, follows the existing authorization, scheduling, OTP, retry, and error-notification behavior of each enabled integration, and never participates in cutover success or reads quarantined downloads. Until valid new Captures arrive, affected financial views show an explicit empty or awaiting-collection state rather than legacy values.
_Avoid_: Cutover-time remote dependency, legacy replay, placeholder financial value, all-integrations transaction

**Source assertion**:
A Canonical Assertion for a fact explicitly supported by a Source Record, including a contract-versioned translation or conservative parent mapping only when it preserves the source field's declared semantics without adding an OctopusBeak inference. The original source value and crosswalk version remain in provenance, and its lifecycle stays independent of parser interpretations or user corrections.
_Avoid_: Derived assertion, user assertion, imported projection

**Derived assertion**:
A Canonical Assertion produced when a parser, normalization, enrichment, or reconciliation rule adds an OctopusBeak interpretation not explicitly claimed by the source, such as inferring personal purpose from MCC, merchant name, free text, invoice items, or combined fields. It retains its producer and rule version; a newer derivation may supersede an older one in the same claim lineage without claiming that the source evidence changed.
_Avoid_: Source fact, user correction, unversioned inference

**Derived assertion lifecycle**:
The append-only result of an atomic, successful, complete-scope Import Run for one producer, subject, field, and rule lineage: a changed supported value supersedes the prior Derived Assertion, an explicitly unsupported optional fact withdraws it, and an unchanged value only gains run provenance. Failed or partial runs change no assertions or projections, and one producer never supersedes another producer's lineage.
_Avoid_: Missing-output withdrawal, partial commit, cross-producer overwrite

**Derived enrichment admission**:
The producer-version-specific gate that emits exactly one optional Transaction Kind, Personal Category, or Counterparty enrichment Assertion only when its versioned and fixture-tested mapping or calibrated confidence threshold supports a unique result. Scores may remain lineage metadata but are never canonical values or comparable authority across producers; a low score, tie, unsupported result, or missing output emits no Assertion, and Automatic Enrichment Authority Routing never ranks candidates at runtime.
_Avoid_: Global confidence scale, low-confidence canonical value, candidate persistence, score-based producer priority

**User assertion**:
A Canonical Assertion recording a person's explicit correction or choice for a user-governed field, including actor, decision time, and optional rationale. It may take precedence in the current projection or be withdrawn so projection falls back to the next valid assertion, but never rewrites or supersedes Source or Derived Assertions.
_Avoid_: Source correction, destructive override, silent preference

**User-governed field**:
A registered, typed descriptive or organizational field such as display name, category, tag, or note for which the first version permits a User Assertion to control the current projection. The field set is defined by the product contract rather than arbitrary user keys or JSON values. Source financial amounts, currencies, directions, dates, lifecycle states, balances, holdings, Statement totals, and membership are not user-governed; suspected errors may be annotated but do not enter financial calculations as corrected facts.
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
The atomic hard deletion of a prevalidated ownership closure containing all Captures and dependent Records, identities, Assertions, revisions, relationships, sync state, and projections in an affected integration namespace, source connection, product stream, contract version, or identity epoch after an admitted contract is proven wrong. The closure must not cross into another source scope or shared operational configuration; any unexpected external reference aborts the purge. It is an exceptional replacement for correction lineage in the first version: only scope, reason, counts, fingerprint, and other non-financial operational audit metadata remain, the old contract and epoch are disabled, and recovery requires recollection under a new version or epoch.
_Avoid_: Assertion withdrawal, partial row deletion, cross-source cascade

**Canonical deletion completion**:
The point at which a committed Contract Purge, Canonical Reset cleanup, or separately specified user deletion makes the removed financial data unreachable from every application query, projection, lineage, and recovery path. A resumable local storage scrub may follow to clear database and journal remnants, but the product does not claim forensic erasure from operating-system snapshots, external backups, or storage-device internals.
_Avoid_: Assertion withdrawal, query-hidden archive, forensic erasure guarantee, backup deletion

**Source authority routing**:
A versioned, immutable contract-defined assignment of exactly one authoritative integration, connection, product stream, and producer to each projection input scope at one Canonical Knowledge Point, preventing duplicate financial facts without merging source-scoped identities. Missing or overlapping routes fail admission or projection rebuild rather than invoking runtime priority; route changes create new knowledge and Historical Financial Projections retain the route valid at their cutoff. Another source may serve a different stream, but no fuzzy or user-selected reconciliation moves facts between identities.
_Avoid_: Cross-source deduplication, identity merge, last-write-wins

**Automatic enrichment authority route**:
A versioned projection assignment of exactly one Source or Derived producer for an optional Transaction Kind, Personal Category, Counterparty participation, or display field in a declared subject scope. It is consulted only when no active User Assertion is permitted and present for that field; missing output yields absence, while overlapping authoritative producers fail admission or projection rebuild rather than being ranked by recency or confidence.
_Avoid_: Latest enrichment wins, confidence auction, cross-producer supersession, user financial authority

**Account display group**:
A user-governed presentation grouping that may place multiple source-scoped Financial Accounts together without changing identity, relocating facts, deduplicating transactions, or authorizing their values for aggregation. It may be renamed or removed independently of all source evidence.
_Avoid_: Canonical account, reconciliation group, calculation authority

**Source assertion lifecycle**:
The append-only, provenance-bearing history `observed`, `revised`, `withdrawn`, and `restored` describing what a source asserts about a canonical projection. Only an explicit source tombstone or absence from a comparable contract-declared complete scope may withdraw a claim, and later reassertion of the same stable key may restore it; users cannot initiate either action, and neither action implies refund, reversal, cancellation, deletion, or Contract Purge.
_Avoid_: Economic transaction status, incomplete-scope absence, user withdrawal, contract purge

**Import run**:
A processing execution that reads Source Records and evaluates one declared complete subject, field, producer, and rule-lineage scope under identified parser and rule versions. It becomes visible only when the entire output succeeds and atomically updates its Derived Assertions and Current Financial Projection; failed or partial output leaves the prior complete result unchanged and produces only operational failure audit. Initial required mapping failure cancels its attempted Source Capture, while reprocessing an accepted Capture never creates source evidence, Source Assertions, or Observations.
_Avoid_: Source capture, financial event

**Evidence replay boundary**:
The first version can re-evaluate derivation and normalization only from fields retained in compact Source Records; it does not preserve raw artifacts or promise to replay extraction from historical files, responses, or pages. An extraction-contract change that needs discarded source content requires a new source collection and cannot retroactively reinterpret the old capture.
_Avoid_: Raw archive, artifact blob, full extraction reproducibility

**Canonical retention**:
Accepted Captures, compact Records, identities, revisions, Assertions, transitions, provenance, Statements, and Measurement History have no time-based expiration and remain available for Historical Financial Projection, Lineage Inspection, and deterministic rebuild until an explicit Contract Purge, Canonical Reset, or separately specified user data-deletion action removes them. Disconnection, configuration change, Assertion withdrawal, or loss of current authority never implies deletion; only operational checkpoints, staging data, logs, and retired projections may have bounded retention.
_Avoid_: Rolling financial TTL, disconnect-as-delete, projection compaction, expired lineage

**Canonical schema evolution**:
A monotonic, forward-only versioning policy in which semantics-preserving structural changes migrate transactionally before the canonical writer and query boundary open, while projection-only rule changes rebuild and atomically switch a shadow projection generation without rewriting canonical history. A model change that requires identity, effective-time, or evidence facts the retained data cannot prove must purge and recollect the affected contract or identity epoch, or perform a Canonical Reset when the incompatibility is global; migrations never invent missing facts, downgrade schemas, or let an older application write a newer database.
_Avoid_: Best-effort backfill, invented evidence, in-place projection rewrite, schema downgrade

**Taxonomy package**:
The repository-authored, fixture-tested bundle that immutably defines one version of Transaction Kind, Personal Category, or Counterparty Role codes, parentage, semantics, applicability, localization keys, and producer compatibility. CI rejects cycles, missing parents or labels, duplicate codes, illegal applicability, mutation or deletion of published definitions, and invalid producer output; one source generates runtime types, validators, localization references, and transactional canonical seed migrations. Packages ship only inside an immutable Desktop Release, never as a remote hot update, and installing a version makes its codes available without reclassifying old Assertions.
_Avoid_: Runtime-editable enum, remote taxonomy update, duplicated hand-written registries, automatic historical rewrite

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
A balance measurement associated with a financial account and typed according to its actual meaning, such as ledger balance, available balance, credit limit, or amount due. It requires provenance plus contract-established effective, observation, and recording times so it can support historical valuation. A source-reported transaction `balance_after` may support a derived post-transaction ledger observation only when the contract establishes its effective ledger point or ordering; it is never presented as a real-time provider balance, and incomplete transaction history never synthesizes an account balance.
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

**Canonical financial revision**:
An immutable, internally complete version of a financial fact whose required values are admitted and superseded as one coherent unit, while its Assertion lineage records origin, producer, supporting evidence, and knowledge time without turning each required financial field into an independently drifting claim. Transactions, Statements, and corrected Observations retain their specialized revision rules; independently governed descriptive fields continue to use field-level Assertions.
_Avoid_: Mutable financial row, generic field-value bag, partial financial revision, duplicated assertion payload

**Observation revision**:
An append-only correction lineage used only when an integration's verified source contract establishes that later evidence corrects the same source-side measurement. A new collection, a matching effective time, or reprocessing the same Source Capture is not by itself a revision; parser reinterpretation instead produces a versioned Derived Assertion.
_Avoid_: New observation, duplicate import, parser reinterpretation

**Financial transaction**:
A source-scoped canonical projection of a monetary event associated with a Financial Account, identified within one integration namespace, connection, product stream, stable source key, and identity epoch and traced to its Source Records. Occurrences from another integration or connection never share its identity; an integration unable to determine the key uniquely fails admission rather than creating a candidate or duplicate merge.
_Avoid_: Cross-source transaction, import record, statement line

**Transaction kind**:
A stable, hierarchical machine classification of what financial operation one Financial Transaction represents, independent of its account-relative direction, posting status, personal purpose, Counterparty, and Transaction Relations. The first-version registry contains the parents `purchase`, `transfer`, `payment`, `cash`, `income`, `fee`, `interest`, `tax`, `refund`, `reversal`, `adjustment`, `loan`, and `investment`, with registered children for internal/external and investment transfers; bill, credit-card, and loan payments; cash deposit/withdrawal; employment, business, pension, benefit, rental, reward, dividend, and investment-distribution income; bank, card, loan, and investment fees; earned/charged interest; payment/refund/withholding tax; loan disbursement; investment buy/sell/short/cover/reinvestment trades; and supported corporate actions. An Assertion uses the most specific contract-proven code, may stop at a valid parent such as `transfer`, and retains its taxonomy version; child codes must aggregate safely to their parent, localized labels never establish identity, and changing an existing code's meaning requires a new taxonomy version. Transaction Kind is optional enrichment unless an integration contract declares it necessary to interpret a particular record kind, such as an investment trade whose buy or sell semantics govern quantity and cash effects; an absent optional kind is not stored as `unknown` or `other`, while an unresolved required kind cancels the attempted Capture. `transfer.internal` may exist from source proof about one transaction without another observed transaction; a `transfer_counterpart` Relation additionally requires both canonical endpoints and contract-proven linkage. Refund and reversal Kinds may likewise stand alone, while their Relations require proof of the original transaction.
_Avoid_: Personal category, merchant type, transaction direction, posting status, relation

**Personal category**:
A product-managed, typed, versioned classification of the personal-finance purpose assigned to a Financial Transaction or invoice item. The first version publishes only the top-level codes `food_and_groceries`, `dining`, `alcohol_and_tobacco`, `clothing_and_footwear`, `housing_and_utilities`, `household_goods_and_services`, `healthcare`, `transportation`, `travel`, `information_and_communication`, `recreation_sports_and_culture`, `education`, `personal_and_family_care`, `insurance`, `taxes_and_government`, `gifts_and_donations`, and `work_and_business`; income, transfer, payment, and fee semantics remain Transaction Kinds. Detailed children are added only when a non-overlapping definition, actual use case, contract fixtures, and safe parent aggregation exist, never as speculative placeholders. Each target has at most one current category; absence is presented as unclassified without storing an `uncategorized`, `general`, or `other` value, while a transaction spanning several purposes uses a complete Category Allocation rather than unordered multiple categories. Source and Derived Assertions may propose registered categories, an active User Assertion takes display and analytical precedence without overwriting them, and clearing it falls back to the currently routed automatic producer. First-version users cannot create, rename, move, or delete taxonomy nodes; personal organization uses Transaction Tags. Every Assertion retains taxonomy ID, version, and exact code; code meaning and parentage are immutable, additive children do not rewrite ancestors, deprecated codes remain historically readable but unavailable for new Assertions, and reclassification requires a new evidence-backed Source or Derived Assertion rather than migration by label or old category. Personal Category is independent of Transaction Kind and Counterparty: the same merchant may serve several purposes, and the same purpose may contain purchases, fees, refunds, or other kinds.
_Avoid_: Transaction kind, merchant identity, source description, tag

**Category applicability**:
A versioned compatibility rule permitting Personal Category only for `purchase`, general or bill/loan `payment`, `fee`, charged `interest`, payment/refund `tax`, `refund`, `reversal`, and explicitly registered descendants. Transfer, cash movement, income, earned interest, credit-card payment, loan disbursement, investment, and adjustment Kinds reject Source, Derived, or User Categorization; an absent Kind cannot be replaced by Category, though one complete producer may admit a compatible Kind and Category together. Tags remain available for non-category organization.
_Avoid_: Category-as-kind, categorized cash withdrawal, categorized card payment, user financial reinterpretation

**Category allocation**:
An immutable, atomically versioned analytical distribution of one Financial Transaction's exact booked amount across two or more Personal Categories. Every component has a non-negative exact amount and the set may participate in aggregation only when its amounts reconcile completely in the booked currency, or through explicit conversion evidence, to the unchanged Transaction amount. Invoice-item categories may derive an allocation only after the invoice-to-transaction identity and complete amount reconciliation are established; otherwise item classifications remain separate enrichment.
_Avoid_: Multiple category labels, transaction amount correction, partial allocation, guessed remainder

**Current categorization**:
The mutually exclusive current analytical treatment of one Financial Transaction as one Personal Category, one complete Category Allocation, or absence. An active complete User Categorization takes precedence over the one Source or Derived result selected by Automatic Enrichment Authority Routing; switching between single and allocated modes supersedes the prior mode atomically, and clearing the user lineage returns to the currently routed automatic result. A failed or partial Import Run preserves the prior automatic categorization, while a successful complete-scope run that proves prior reconciliation unsupported withdraws the whole allocation and never retains a partial component or guesses a single category from it.
_Avoid_: Simultaneous single and allocated category, partial split, run-failure withdrawal, implicit category fallback

**Relation-backed categorization**:
A versioned Derived Categorization for a refund or reversal that inherits an original transaction's Current Categorization only when a valid `refund_of` or `reversal_of` Relation makes the inheritance safe. A full reversal or a partial refund of a single-category original may inherit, while a partial refund of an allocated original requires its own complete evidence-backed or User Allocation and never receives a proportional guess. Changes to the original categorization or Relation cause a successful complete-scope producer to supersede or withdraw the inherited result; failed runs preserve the prior result, and a refund's own User Categorization remains authoritative.
_Avoid_: Source category copy, fuzzy refund match, proportional allocation guess, orphaned inherited category

**Unclassified presentation bucket**:
The query-time sum of transactions that satisfy a report's independent financial inclusion rules but have no Current Categorization at the requested Canonical Knowledge Point. It is never a taxonomy code or Assertion target, remains unavailable for user selection, participates in report totals and classification-coverage metrics, and receives the whole transaction amount when no complete Category Allocation exists.
_Avoid_: `other` category, persisted unknown, dropped amount, partial-allocation remainder

**Financial report inclusion**:
A versioned query policy that determines whether and how a Financial Transaction participates in a financial total from account type, direction, Transaction Kind, relations, posting status, Statement facts, and other admitted financial semantics before consulting Personal Category. Category, Tags, Counterparty display, alias, and notes may organize an included amount but never admit, exclude, or change it; if a report requires an absent optional Kind, the query returns an explicit eligibility coverage gap and affected amount rather than silently counting, dropping, or persisting an `unknown` status.
_Avoid_: Category-controlled cash flow, tag exclusion, silent incomplete total, user financial override

**Classification coverage**:
A query result describing how much of a financially included result set has a Current Categorization and how much falls into the Unclassified Presentation Bucket at the requested Canonical Knowledge Point. It is computed from Assertions selected by the query rather than persisted as transaction status, so changing a knowledge cutoff, report scope, or successful enrichment result reproduces the corresponding coverage without rewriting financial facts.
_Avoid_: Categorization status row, `unknown` category, cached authority

**Report eligibility coverage**:
A query result identifying the count and amount of otherwise relevant Financial Transactions for which a report's versioned inclusion policy lacks a required admitted semantic, such as an optional Transaction Kind that the source did not provide. It reports that the financial total cannot yet be claimed complete; it never resolves the gap by guessing, silently excluding the amount, or storing a conflict or unknown status on the transaction.
_Avoid_: Silent report omission, guessed kind, persisted eligibility status, partial truth presented as complete

**Current transaction enrichment**:
A rebuildable query projection that returns the route-selected Transaction Kind, mutually exclusive Current Categorization, all typed Counterparty Participations, selected display label and its origin, and active Transaction Tags at one Canonical Knowledge Point. Every selected value retains its exact taxonomy version, Assertion origin, and provenance; the projection creates no second history because its authority remains the underlying Canonical Financial Commits and Assertion Transitions.
_Avoid_: Mutable enrichment source of truth, duplicated event log, UI-side precedence, untyped enrichment payload

**Enrichment knowledge time**:
The Canonical Knowledge Point at which a Transaction Kind, Personal Category, Category Allocation, Counterparty display, alias, or Tag Assertion became known, changed, or was withdrawn. These descriptive and organizational facts inherit the Financial Transaction's financial date for period membership but never receive a separately backdated financial `effective_at`; current-knowledge reports may reorganize old transactions, while a knowledge cutoff reproduces what the product displayed at that earlier point.
_Avoid_: Backdated user category, enrichment effective date, category-changing transaction time

**User categorization scope**:
The explicit set of Financial Transactions, invoice items, or complete Category Allocations selected by a person for one category operation. A single or bulk action creates a User Assertion for every named target but never becomes a merchant-name, Counterparty, or future-transaction rule; reusable automatic user rules require a separate versioned producer and precedence specification outside the first version.
_Avoid_: Always categorize merchant, implicit future rule, fuzzy bulk scope, alias-based categorization

**Counterparty**:
An optional evidence-backed party participating in a Financial Transaction, typed by its role such as merchant, marketplace, payment platform, financial institution, income source, government, or person. A transaction may retain several typed Counterparty Participations, while Current Projection chooses one reproducible display Counterparty from Transaction Kind and contract-defined role precedence without deleting or authorizing the others. A Counterparty Reference may be reused across transactions only when its source or enrichment producer supplies a stable entity key within that producer namespace; an explicitly provided and contract-validated registered identifier such as a Taiwan seller business number may identify the reference only inside that scheme and producer scope. Different producers never merge references by name, and without a stable key the transaction retains only a transaction-scoped display Assertion. First-version reference descriptions are limited to display and legal names; mutable web profiles, logos, contact details, geolocation, opening hours, inferred corporate groups, and unused source fields are not promoted or retained speculatively. Display normalization may be superseded without changing Financial Transaction identity, while similar names, company groups, user guesses, and a matching Institution label never establish shared identity. A Merchant is one Counterparty role rather than a universal transaction field; transfers, cash activity, and other transactions may have no merchant.
_Avoid_: Personal category, raw transaction description, canonical Institution identity, guaranteed merchant

**Counterparty participation**:
An immutable, provenance-bearing association between one Financial Transaction and one transaction-scoped or producer-scoped Counterparty in exactly one registered role, retaining its observed name, optional Counterparty Reference, and optional typed source classification scheme/code. Several participations may coexist, such as marketplace, underlying merchant, and payment platform; an unsupported role is absent rather than stored as `other`, and selecting one participation for display never merges identities or changes financial semantics.
_Avoid_: Single merchant field, display-name identity, institution merge, personal category

**Merchant classification**:
An optional source- or producer-scoped scheme and code, such as an evidence-backed ISO 18245 merchant category code, describing a merchant's business activity rather than the purpose of one purchase. It may support a versioned Derived Personal Category but never becomes that category directly, and unsupported addresses, store metadata, websites, logos, or external company information are absent from the first-version canonical projection.
_Avoid_: Personal category, merchant identity, transaction kind, guessed business profile

**Counterparty display override**:
A User Assertion that changes only presentation, either for one Financial Transaction or as a shared alias on an existing producer-scoped Counterparty Reference. Transaction-specific text takes precedence over a reference alias and the routed Source or Derived display, while a reference alias is unavailable without a stable producer key; neither scope changes the selected participation, role, identity, Personal Category, Transaction Kind, or similarly named Counterparties.
_Avoid_: Merchant merge, fuzzy bulk rename, identity correction, category override

**Transaction display label**:
The current user-facing title selected in order from a transaction-specific User override, the selected Counterparty's User alias, its routed Source or Derived display name, and finally the Financial Transaction's source description. The query returns the selected origin and keeps `display_counterparty` absent when it falls back to transaction text, so a readable label never fabricates Merchant identity or authorizes grouping by similar strings.
_Avoid_: Description-as-merchant, display-name identity, fuzzy merchant grouping, hidden label origin

**Transaction tag**:
A reusable user-owned entity applied independently of Transaction Kind, Personal Category, and Counterparty to organize Financial Transactions for a person's own context, such as reimbursable, travel, or renovation. Its stable local ID is separate from a renameable display label whose normalized current form is unique in the user scope; each transaction association has its own User Assertion lifecycle, removal withdraws only that association, and ordinary tag deletion archives the entity while preserving history unless a separate user-data deletion applies. Source and Derived producers cannot create or apply Tags, and a Tag carries no financial calculation, identity, authority, or source meaning.
_Avoid_: Personal category, source classification, financial fact, transaction relation

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
A lossless, normalized decimal magnitude paired with an explicitly identified denomination; numerically equal values have one canonical equality representation regardless of source padding or display precision. Canonical amounts and rates never use binary floating point, while source formatting remains in the immutable Source Record and display rounding never changes the underlying value. Fiat denominations use ISO 4217, and any non-ISO denomination belongs to a distinct controlled scheme rather than masquerading as an ISO currency.
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
An optional, provenance-bearing, immutable typed relationship between two non-identical Financial Transactions within one contract-provable Source Connection and Identity Epoch, initially typed as `pending_to_posted`, `refund_of`, `reversal_of`, `transfer_counterpart`, or `installment_of`. Its endpoints and type are created only from explicit source evidence or a validated uniquely deterministic integration contract and never change in place; withdrawal and restoration affect its Assertion support. Users cannot establish financial relations; unsupported optional relations are absent, and admitted relations never merge or delete transactions, impose a global one-to-one constraint, or invent amount allocations.
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
An append-only correction lineage created only when an integration's verified contract proves that the source reissued or corrected the same Statement through stable identity, revision, or replacement semantics. Each revision immutably owns its source-reported totals, dates, and membership pinned to the specific Transaction Revisions used by that statement version, so later transaction changes cannot rewrite old billing history. A different billing cycle creates a new Statement, and the first version does not allow a User Assertion to choose between ambiguous Statement candidates.
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
