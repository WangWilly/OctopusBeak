# src never names an electron module

Status: accepted

Enforces the direction that [ADR 0118](0118-pglite-worker-rpcs-share-one-call-core.md) asserted. Extends the rules of [ADR 0114](0114-a-check-keeps-main-only-code-out-of-the-renderer.md) and [ADR 0131](0131-the-ledger-never-names-a-workflow-module.md).

## Context

ADR 0118 said that `src/` does not import from `electron/`. No check enforced this. `scripts/dependency-direction.check.mjs` refused only the `electron` package in `src/` (ADR 0073), not modules under `electron/`. Two kinds of `src/` code named `electron/` modules:

- Automation and spending modules imported main-side helpers. The spending desktop service called `prewarmPGlitePairingCandidates` from the financial registry, although the helper used only the port the service already receives.
- The renderer's Financial page typed its live views with `PGliteFinancialLiveView` and `FinancialLiveViewDtos`. Both were derived from main's `FINANCIAL_LIVE_VIEWS` table.

The PGlite RPC protocol layer also lived under `electron/`, although both main and its workers run it.

## Decision

**`scripts/dependency-direction.check.mjs` adds `srcImportsOfElectron`: no non-check module under `src/` names a module under `electron/`.**

- The rule counts every specifier, including `import type`, `export … from`, `import()` and `import("…")` types. A type import counts because it makes `src/` depend on where main wires itself.
- Checks, fixtures and check-support files are exempt, using the same `isCheckFile` test as `electronImportsInSrc`. Integration checks wire real electron RPC servers, such as the financial registry and the child RPC server, to exercise `src/` code over the real protocol.
- `src/lib/pglite-rpc/` is the shared protocol layer. It holds the financial and operational contract tables, the call core, the RPC clients, and the live view names. Main, its workers and the workflow child all run it.
- `electron/` holds only main-process wiring: the registry, RPC servers, worker hosts, and the live view table.
- Shared names move to `src/`, and `electron/` checks itself against them. `src/lib/pglite-rpc/pglite-financial-live-views.ts` declares `FINANCIAL_LIVE_VIEW_NAMES` and the DTO map. Main's `FINANCIAL_LIVE_VIEWS` `satisfies Record<PGliteFinancialLiveView, FinancialLiveViewDefinition>`, so a view missing on either side fails typecheck.
- The renderer check refuses `src/lib/pglite-rpc/` as main-only code. Before the move, it refused these modules as Electron main code. A type-only import from the renderer stays allowed, because the build erases it.

## Considered options

- **No check exemption.** Rejected. ADR 0131 refused the exemption because moving four checks cost nothing. Here, the integration checks need a real electron server. Moving that server into `src/` would put main-process wiring into the shared tree.
- **Re-export the live view types from `electron/`.** Rejected. Only two checks imported them, and they now import from `src/`.

## Consequences

- `src/` code that needs a main-side helper or type must move it into `src/` first, or receive it as a port.
- A new live view needs its name in `FINANCIAL_LIVE_VIEW_NAMES` and its definition in `FINANCIAL_LIVE_VIEWS`. Typecheck fails until both exist.
- A renderer module that value-imports `src/lib/pglite-rpc/` fails the renderer check directly, with the PGlite RPC reason.
