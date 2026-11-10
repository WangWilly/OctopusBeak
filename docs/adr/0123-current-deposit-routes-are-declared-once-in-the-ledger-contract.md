# Current deposit routes are declared once in the ledger contract

Status: accepted

Refines [ADR 0096](0096-the-snapshot-module-verifies-the-provider-response.md): a current deposit source still declares the response that carries its snapshot, but the declaration reads its host, path and Cache-Control directives from the route contract. Keeps [ADR 0107](0107-the-snapshot-module-assembles-every-current-state-capture.md): each bank still names its route key and mints its capture id. Holds [ADR 0035](0035-source-contract-catalog-and-rule-admission.md) and [ADR 0085](0085-opening-a-store-installs-newly-registered-contracts.md): the registry installed into the store is unchanged.

## Context

Each of the 13 current deposit balance routes was written by hand in three places, plus the builders:

- the route contract table in the PGlite admission, which checks every capture;
- the route's entry in the canonical source route registry, which is installed into the store;
- the bank's workflow, as host, path and contract version constants and the response declaration built from them.

The builders also typed each route key as a plain string, so a misspelled route failed only when admission rejected the capture. The registry entries held nothing the contract lacked: route key, namespace, stream, and one effective-time rule named by the contract version.

## Decision

**`src/ledger/canonical/current-deposit-route-contracts.ts` declares each current deposit route once.** The table is `as const`, so its keys form `CurrentDepositAuthorityRoute`, the type of a capture's authority route. The module imports only the TDCC settlement contract, so the registry, the PGlite admission and the workflows can all read it without a cycle.

- **Admission** reads the table and keeps every runtime check. A capture reaches PGlite untyped, so the route is still looked up as any string.
- **The registry** derives each current-balance registration from its contract, at its existing position. Statement, credit-card and other registrations stay hand-written.
- **Workflows** take a response declaration's host, endpoint path and Cache-Control directives from the contract, and the request resource or discriminant where the contract names one. Method, content type, allowed query, provider date and page URLs stay in the workflow.
- **Builders** name their route key literally, typed by the table, and read the contract version from the contract.
- Where one declaration serves two routes (SinoPac, Yuanta, HNCB), it reads one route's contract. A check pins that the routes sharing it agree on host, path and cache directives.

The provider date rule is not shared. The contract names the time evidence admission accepts, while the declaration names whether the response must carry an HTTP Date. Post accepts either an HTTP Date or the body's server time, so the two rules are not one fact. The allowed query is not shared either. The contract checks the stored endpoint's query, while the workflow matches the live URL, which may carry provider transport keys that the stored endpoint never keeps.

## Considered options

- **Keep the registry hand-written and add a consistency check.** Rejected. The 13 entries had no field the contract lacks, so a check would only guard a copy that need not exist.
- **Derive the provider date rule from the contract.** Deferred. The mapping is not one to one, and no current source drifts on it.

## Consequences

- The derived registrations are field-for-field identical to the hand-written ones, in the same order, so opening an existing store installs nothing new and no canonical reset is needed.
- No persisted value changes. The deposit commit goldens are unchanged.
- A misspelled route key in a builder is a type error.
- A new current deposit route adds one contract entry, names its key in its builder, and adds its registration at the position it takes in the registry.
- Credit-card current balance contracts are still declared separately.
