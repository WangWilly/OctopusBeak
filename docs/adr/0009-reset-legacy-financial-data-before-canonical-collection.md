# Reset legacy financial data before canonical collection

Status: accepted

OctopusBeak will not migrate its product-specific legacy ledger into the strict canonical financial model. The breaking-change release instead performs a version-triggered Canonical Reset Cutover, preserving only operational configuration and rebuilding all financial state from newly collected, contract-compliant Captures. This deliberately loses legacy history because the inspected data cannot uniformly establish the identity and effective-time semantics required by the current model, while a compatibility migration would reintroduce exceptions the canonical admission boundary was designed to exclude.

## Decision

Before release, every enabled integration configuration that may survive the reset, and every integration the release continues to advertise as supported, must pass the Canonical Recollection Readiness Gate. Its versioned fixtures must resolve every identity, classification, status, effective-time, completeness, and authority requirement needed by the current canonical model. An unready supported integration blocks the release; old data compatibility is not part of this gate.

On first startup of the breaking-change version, the application automatically and atomically:

- moves the legacy ledger and downloads into Legacy Data Quarantine, outside all application read, import, replay, fallback, and recovery paths;
- carries forward only Sign-in Details, enabled-integration configuration, Statement Selections, and non-financial preferences; and
- creates and validates a new empty canonical store with new Source Connections and Identity Epochs.

Financial records, Source Captures, Source Records, assertions, projections, user financial overrides and classifications, Source Sync State, import history, and automation-run history are not copied. Failure before commit leaves the legacy files unchanged and refuses to open a partial canonical store; it never falls back to the legacy model.

Remote collection is not part of the cutover transaction. After local cutover commits, enabled integrations repopulate the store through ordinary Post-reset Recollection, including their normal scheduling, authentication, OTP, retry, and error-notification behavior. Until new Captures arrive, financial views show an explicit empty or awaiting-collection state and never display legacy values.

Legacy Data Quarantine is a temporary safety buffer, not a supported restore path. The following application release automatically destroys it only when a durable local marker proves that cutover completed, the canonical store opened successfully, at least one contract-compliant recollection completed, and no canonical application path read the quarantined files. Otherwise the quarantine remains untouched for a later release. Physical deletion is never part of this ADR's planning work and must be implemented and verified separately.

## Consequences

- Legacy financial history, classifications, overrides, lineage, and run history are intentionally unavailable after reset and eventually deleted.
- No migration mapper, dual read, dual write, compatibility projection, legacy fallback, Identity Correction, or raw-download replay mechanism is built.
- The canonical model remains total and conflict-free: missing required semantics cause integration admission failure rather than a legacy exception.
- New collection may not immediately recover history that a provider no longer exposes; the product must describe the affected view as awaiting collection or unavailable rather than imply continuity.
- The inspected local ledger and downloads informed feasibility only, as recorded in [Current local ledger feasibility for canonical reset](../research/current-ledger-canonical-reset-feasibility.md). They are not migration fixtures and are not modified by this decision record.

## Rejected alternatives

- Migrate only legacy rows that appear compatible: rejected because it creates partial, product-dependent history and still requires migration-specific identity and time rules.
- Keep the legacy database as a read-only compatibility view: rejected because it creates mixed authority and lets unqualified values bypass canonical admission.
- Recollect during the cutover transaction: rejected because bank availability, OTP, and integration-specific retries would turn a local atomic replacement into a distributed transaction.
- Delete legacy files immediately: rejected in favor of one release of read-disabled quarantine guarded by durable success markers.
