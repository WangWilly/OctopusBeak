# The durable attestation chain is the only authority for a Human-attestation contract

Status: accepted

## Decision

A Human-attestation contract is active or revoked only according to its durable PGlite event chain, the provider `*_attestation_events` table described in [ADR 0017](0017-canonical-schema-lifecycle.md). Each financial admission already checks that chain inside its own transaction through `assertPGliteHumanAttestationActive`, and a revoked chain rejects the capture.

Before this decision, each `src/ledger/canonical/*-human-attestation-contract.ts` also held a process-local copy of its manifest with a mutable status, and admission code checked that copy through `is…Active()` before reaching the durable check. Nothing in production ever changed the copy: the revoke, restore, replace, and set-status functions that could flip it had no callers. The process-local check therefore always passed, while code and tests read as if two independent gates protected admission.

So each contract module is now static data and pure helpers:

- **The manifest is a constant.** Its route, version, semantics, provenance fingerprint, and identity-epoch derivation stay exactly as before. `get…Manifest()` and the module-level current manifest are gone; callers use the constant.
- **No process-local status.** `is…Active()` and every function that mutated the manifest are removed, along with the admission branches that only ran when it returned false.
- **Revocation is a durable event.** Revoking or restoring an attestation appends to the PGlite chain through `revokePGliteHumanAttestationInTransaction` or `restorePGliteHumanAttestationInTransaction`. It takes effect for the next admission in any process, including after a restart.

## Considered options

- **Load the durable status into the process-local copy at startup and on every revoke.** Rejected. It would let admission refuse before opening a transaction, but it adds a second state that must be kept consistent with the chain across processes and restarts, for a check the in-transaction gate already performs.
- **Keep the process-local copy as defensive depth.** Rejected. A gate nothing can close is not depth; it misleads readers about where revocation is enforced, and its only test asserted that it returned true.

## Consequences

- An admission's attestation outcome depends only on the PGlite chain read in its own transaction, so it cannot disagree between the workflow child and the worker.
- `human-attestation-revoked` remains a valid diagnostic code for recorded data, but pure admission no longer emits it; a revoked chain surfaces as the durable gate's rejection.
- Removing a contract's last caller of a pure helper is ordinary dead-code cleanup; adding runtime status back requires a new decision.
