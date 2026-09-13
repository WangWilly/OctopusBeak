# Reset financial data and adopt canonical-only operation

Status: accepted — revised after confirming there are no existing product users.

OctopusBeak has no existing users whose financial history requires compatibility or retention. The canonical-only transition directly discards the previous financial stores and downloads and rebuilds from new contract-compliant collection; no migration, read-disabled quarantine, delayed cleanup release, or compatibility adapter is required.

## Decision

Preserve only Sign-in Details, enabled-integration configuration, Statement Selections, and non-financial preferences. Do not carry financial rows, classifications, overrides, Source Sync State, import history, or automation-run history into the new store. Resolve reset targets precisely, including database sidecars, without deleting preserved configuration or unrelated files.

Reset initialization is explicit and resumable: fresh installs and ordinary restarts open only a validated canonical store; a completed reset is not repeated on every launch. An interrupted reset may retry, but never exposes a partial store, restores old financial data, or falls back to legacy reads. Retaining old financial files unchanged on failure is no longer a requirement. Remote collection starts only after local initialization completes and is not part of that local transaction.

Remove legacy startup, query, import, replay, recovery, and projection paths alongside the cutover. Retire the Data Issues page and its dedicated implementation. Until new collection succeeds, financial products show empty, awaiting-collection, or unavailable states.

All enabled and advertised sources, including E-Invoice, must pass aggregate canonical admission and empty-store recollection acceptance. First inspect durable evidence from existing manual workflow runs rather than treating static readiness defaults or task completion alone as proof. Canonical-only implementation may begin before this gate passes; final acceptance still requires valid source contracts, atomic commits, idempotency, failure isolation, and canonical product queries.

## Consequences

- Issues #147 and #148 form one canonical-only reset and legacy-retirement scope; #146 is the final admission/recollection acceptance gate.
- Issue #149 is cancelled because there is no quarantine to clean in a later release.
- Normal authentication, OTP, human assistance, scheduling, retry, and notifications continue through the unified synchronization flow.
- No compatibility or forensic-erasure guarantee is introduced. This decision specifies future reset behavior; editing the decision itself does not delete local data.
