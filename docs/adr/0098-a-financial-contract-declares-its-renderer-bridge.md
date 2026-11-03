# A financial contract declares its renderer bridge

Status: accepted

Builds on [ADR 0090](0090-every-bridge-channel-is-declared-once-in-preload.md), whose sandbox rule it keeps.

Ten financial operations are open to the renderer: nine Spending operations and the Manual asset command. Each one was spelled in five places: its contract in `PGLITE_FINANCIAL_CONTRACTS`, its registry handler, `RENDERER_FINANCIAL_OPERATIONS` in `ipc-channels.ts`, its preload channel, and a hand-written signature in `src/lib/desktop/api.ts`. The signature was checked against the contract by a type, `MismatchedForwards`, that existed only to compare the two copies. The files that held them did not say what they held: the contract table sat in `pglite-financial-rpc-client.ts`, and `pglite-financial-registry.ts` held the handlers together with the RPC server, the work scheduler, failure categorisation, diagnostics, about forty unused imports, and an `export *` of the client file.

**A contract declares whether the renderer may call it, and under which bridge method.** `rendered(group, method, operation(…))` marks the operation. `RENDERER_FINANCIAL_OPERATIONS` is derived from the marks, and `FinancialBridge<group>` derives the bridge methods' arguments and results from the contracts, so `api.ts` types the Spending and Manual asset methods with it instead of restating them. Spending's candidate-page and prewarm calls, which go through the Spending desktop service, stay hand-written.

**Preload keeps spelling its channels.** Its sandbox may load only `electron` (ADR 0090), so it cannot import the contract table. Instead, a route check fails the build when a marked operation's method is missing from preload or names another operation's channel.

**The financial RPC is four modules, by what changes them.**

- `pglite-financial-contracts.ts`: the contract table and every type derived from it. Its own imports are type-only.
- `pglite-financial-rpc-client.ts`: the client.
- `pglite-financial-rpc-server.ts`: the server, the work scheduler, lane coalescing, failure categorisation and diagnostics.
- `pglite-financial-registry.ts`: the handlers, the page-action events, the local port and the pairing prewarm.

## Considered options

- **Merge the contract table and the registry.** Rejected. They change together whenever an operation is added, but they sit on opposite sides of a real seam: the client in the child process and the view worker imports the contracts, while the registry imports the ledger. One module would load ledger code into every client.
- **Keep a separate operation-to-bridge table in `ipc-channels.ts`.** Rejected. It would keep the renderer route apart from the operation it describes.
- **Share the channel names with preload through a runtime module.** Rejected by ADR 0090's sandbox rule.

## Consequences

- A new renderer financial operation is a marked contract, its registry handler, and one preload line. `api.ts` and the forwarding handlers follow from the contract.
- Renderer code reads its financial bridge types from `electron/pglite-financial-contracts.ts`, type-only, as the Financial page already did from the live views.
