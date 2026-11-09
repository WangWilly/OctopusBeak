# Fubon loan declares its revisable payload fields

Status: accepted

Refines [ADR 0055](0055-revisable-payload-fields-continue-admitted-occurrences.md).

## Context

Each Fubon loan row carries the booked event and, beside it, two observations that change between captures of the same occurrence: the balance Fubon reports after the row (`balanceSourceEvidence`) and the row's display text (`sourceDescription`). Occurrence continuity compares an admitted payload with its recapture, so either change would fail as `occurrence-conflict`. The store allowed it with a hard-coded exception for the `fubon-loan-transaction` record kind. ADR 0055 named that exception as the option it rejected, because a route's admission behavior is reviewed in the closed route registry, not in the store.

ADR 0055 also said a route that sends balance observations must not declare revisable fields. That rule protects against continuation: when a recapture derives a new occurrence key under an admitted collision key, the store moves the record onto the admitted key, and a caller that keys balance observations by its own occurrence keys would then point at a key that no longer exists.

A Fubon loan record's collision key is its occurrence key. The contract builds the key from the account, date, transaction code, direction and amount, and neither changing field feeds it. Continuation runs only when the admitted key differs from the recapture's key under one collision key, so it can never run for Fubon loan.

## Decision

`fubon/loan/canonical-v2` declares `revisablePayloadFields: ["balanceSourceEvidence", "sourceDescription"]`, and the store's Fubon loan exception is deleted. Continuity compares Fubon loan payloads without those two fields, as it already did through the exception. A rewrite of any other field still fails as `occurrence-conflict`.

ADR 0055's restriction on routes that send balance observations applies to routes whose collision key can differ from their occurrence key. A check builds real Fubon loan captures and asserts each record's collision key equals its occurrence key, so a contract change that gives Fubon loan its own collision key fails that check before continuation could re-key a balance observation.

## Consequences

- No Fubon loan behavior changes. A balance-only recapture still adds a balance observation revision and no transaction revision, and a description-only recapture adds neither.
- The store no longer names a record kind in occurrence continuity; every route's revisable fields are read from the registry.
- If Fubon loan ever gets a collision key distinct from its occurrence key, it must stop declaring these fields until balance observation keys are translated through continuation, as ADR 0055 requires.
