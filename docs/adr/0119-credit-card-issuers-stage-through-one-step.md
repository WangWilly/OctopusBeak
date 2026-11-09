# Credit-card issuers stage through one step

Status: accepted

Refines how [ADR 0108](0108-a-broken-credit-card-current-snapshot-fails-the-card-capture.md) holds its guarantee.

## Context

Fubon, Yuanta and E.SUN each wrote the same staging tail by hand: key each card commit by its capture id, bind the current used credit to a card, stage the snapshot, and stage the items. E.SUN staged its card before it staged the snapshot. A broken snapshot still failed the E.SUN card capture, but only because the run discards a product's staged items when the collector throws.

## Decision

**`stageCanonicalCreditCards` in `src/workflows/canonical-credit-card-staging.ts` owns the staging tail for every credit-card issuer.** Each issuer still builds its own commit requests and passes each one with the issuer capture it came from.

- The step validates and stages the current used-credit snapshot first. It then checks the abort signal and stages every card and every balance in one `stage` call. A snapshot that fails validation stages no card.
- The used credit binds to the first card's identity. Used credit is an issuer-aggregate figure ([ADR 0023](0023-credit-card-current-used-credit-estimate.md)), and each issuer's snapshot matches its rows with `issuerAggregateMatching`, which accepts one capture. Every issuer admits at most one card capture per run today.
- With no cards, the step stages nothing and does not stage the snapshot.
- The step lives beside the snapshot module, not with the PGlite credit-card adapters. It needs the product handle and the snapshot module, and the adapters belong to the ledger layer, which does not import from workflows.

## Consequences

- E.SUN now reports the current-balance validation events before it stages its card. The commit goldens do not change, because they record events and committed items, not stage calls.
- A new credit-card issuer stages through this step and gets the ADR 0108 order without writing it.
