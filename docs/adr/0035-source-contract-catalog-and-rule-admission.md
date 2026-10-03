# Installed source contract catalog and rule admission

Status: accepted

The closed source-route registry already rejects unregistered routes, but
contract eligibility and financial rule versions are also repeated across
admission code, PGlite constraints, and attestation metadata. The user approved
a clean database rebuild because the product has no users, so this decision
consolidates trusted contract registration and removes unused contract and
rule implementations without changing the stable behavior of current
workflows.

## Decision

One installed source-contract catalog is authoritative for the exact contract
versions the application trusts and the exact posting, semantic, and
effective-time rule-version combination each version may use. Admission must
check the complete registered combination; independent membership in separate
rule lists or a matching name prefix is insufficient. A capture cannot add a
trusted contract or rule combination.

Provider adapters continue to establish source-specific evidence,
completeness, and financial facts. The catalog records which reviewed contract
and rule combination applies; it does not make provider evidence interchangeable
or change its meaning. For every contract and rule combination used by a
current collection workflow, preserve the accepted evidence, completeness,
identity, and fingerprint semantics. Resolve any existing discrepancy by an
explicit decision before changing that behavior. Remove contract versions and
rule implementations that no current collection workflow uses; references in
tests alone do not make a version current.

Adding a provider for existing financial concepts requires an installed
catalog registration and its provider adapter. It does not require changing
core financial table definitions to enumerate the provider. The catalog is
distinct from `source_authority_routes`, which records runtime Source Authority
Routing history and cannot authorize a contract absent from the installed
catalog.

This change uses a clean PGlite baseline populated from the installed catalog.
It adds no migration, compatibility reader, or history backfill. A database
created against an older baseline must fail closed. Startup must not delete or
reset it; the user explicitly rebuilds the development database and recollects
data. The rebuild does not rewrite retained contracts' immutable evidence or
fingerprint semantics. This decision does not determine whether physically
distinct attestation tables should be consolidated.

## Consequences

- Same-domain provider additions remain local to reviewed registration and
  provider evidence handling while common financial invariants stay in the
  shared schema.
- A capture with an absent contract, mismatched contract version, or
  unregistered rule tuple is rejected before any financial data commits.
- Historical database contents do not require retaining obsolete runtime
  contract readers. An older database needs an explicit rebuild before the new
  baseline can open it.

This source-contract scope supersedes older retention or migration statements
only where they conflict with this decision. It does not revise provider
evidence semantics recorded in accepted source-specific ADRs.
