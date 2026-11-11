# A source's current balances live in one module

Status: accepted

Keeps [ADR 0107](0107-the-snapshot-module-assembles-every-current-state-capture.md) and [ADR 0108](0108-a-broken-credit-card-current-snapshot-fails-the-card-capture.md): the snapshot module still owns the order of reading, matching, building and staging, and each bank still declares what differs. Keeps [ADR 0123](0123-current-deposit-routes-are-declared-once-in-the-ledger-contract.md) and [ADR 0124](0124-credit-card-current-balance-routes-are-declared-once-too.md): builders name their route keys and digest inputs literally.

## Context

A deposit source declares its current balances with one `CurrentStateSnapshotDeclaration`: the provider response, the row parser, the matching, the builder, the product label, the staging kind and an optional whole-snapshot check. Those parts were spread over two or three files per source:

- CTBC, HNCB, SinoPac, Fubon and Yuanta kept the declaration, the matching and the builder in `<bank>-statements.ts`, and the parser in `<bank>-current-deposit-balances.ts`. Yuanta's foreign-currency declaration lived in `yuanta-foreign-currency-statements.ts`.
- Post kept the matching and the builder beside its parser but declared the snapshot in `post-statements.ts`.
- Cathay and LINE Bank kept the matching and the builder in a third file, `<bank>-current-deposit-canonical.ts`. LINE Bank declared the snapshot as an object literal inside its run.

To learn what one source's current balance is, a reader opened up to three files. Checks called the builder directly and matched rows with `indexCurrentBalanceCaptures`, so they tested pieces the run never calls alone, and the module exported those pieces only for the checks.

Yuanta's domestic and foreign builders were two copies of one function. They differed only in stream, route, product label, digest namespaces, one compact key, and the wording of their unmatched, wrong-stream, mismatch and ambiguous messages.

## Decision

**Each deposit source declares its current balances in one module, `src/workflows/<bank>-current-deposit-balances.ts`.** The module holds the response declaration, the parser, the matching, the builder and the identity type of the admitted capture it joins, and exports the declaration. The statements module imports the declaration and hands it to `stageCanonicalDeposits` or the snapshot module.

- A source whose declaration needs run state exports a factory. Cathay's factories take the admitted deposits. LINE Bank's takes the selected accounts and the admitted domestic captures. LINE Bank's account key and currency helpers moved with it, so the balances module does not import the statements module.
- The module exports only the declaration, the readers and table readers other modules use, and the types other modules import. The builder and the matching are not exported.
- `cathay-current-deposit-canonical.ts` and `linebank-current-deposit-canonical.ts` are folded into the balances modules and deleted.

**Yuanta's domestic and foreign deposits share one builder and one matching.** A table keyed by kind holds what differs: stream, route, product label, the three digest namespaces, the compact currency key and the unmatched message. The namespaces are literal strings, never derived from the route contract, because they feed persisted keys (ADR 0123, ADR 0124). The two declarations stay separate exports. The foreign product label stays `current-deposit-balance`.

**Checks drive the declaration.** A check passes the exported declaration, a fixture acquisition and `snapshotCheckProduct` from `current-state-snapshot-capture.fixtures.ts` to `captureCurrentStateSnapshots`, and asserts the staged items: item key, product and the committed request. Identity mismatches, unmatched rows, ambiguous captures and scope checks are asserted as rejections of the snapshot. Parser and DOM reader checks still call the parser and readers.

## Considered options

- **A shared envelope helper in the snapshot step.** Rejected. The envelopes look alike but differ per source:
  - CTBC takes the scope day from `providerDataTime`, rewriting its slashes with `replaceAll`.
  - HNCB lets `sourceEvidence.url` override the contract endpoint.
  - Cathay stamps the capture with the row's `observedAt`.
  - LINE Bank ignores the row's evidence endpoint and builds its own from the contract with a fixed `featureTypeCode` query.

  A helper would need a flag or callback for each difference, so every builder would still name its differences, through one more layer.
- **Keep the builders in the statements modules and export them for checks.** Rejected. The run never calls a builder alone, so checks on it pass while the declaration that wires it can be wrong.

## Consequences

- One file answers what a source's current balance is and how it joins an admitted account.
- A builder guard that matching makes unreachable is no longer asserted on its own. SinoPac's builder currency and stream guards and the HNCB and Fubon account-number guards sit behind matching keys that already include those fields.
- No persisted value changes. The deposit commit goldens are byte-identical.
- Credit-card current snapshots are unchanged.
