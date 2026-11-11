# A check keeps main-only code out of the renderer

Status: accepted

Encodes the boundary [ADR 0073](0073-automation-ipc-forwards-to-one-desktop-service.md) states: Electron capabilities reach `src/` as injected ports. It also encodes the boundary the renderer already keeps, since everything else reaches it over the preload bridge.

## Context

The renderer and main share one source tree. Vite bundles whatever a route imports at runtime. A Node built-in is externalized with a warning and fails only when it is called. A server module ships its module-level state, and its imports, into the renderer bundle. Nothing in the build or the type checker refused either.

Before this check, one route already reached a server module. `ErrorReportDialog.svelte` imported `MAX_NOTE_LENGTH` from `automation/server/error-report.ts`, which pulled in the module that keeps the failure-diagnostic map.

The other directions in the tree do not form a clean order today. `src/ledger` uses shared modules under `src/lib`, `src/lib` uses ledger types, and workflows and automation import each other. Rules for those would start with a long list of exceptions.

## Decision

**`scripts/dependency-direction.check.mjs` enforces two rules, with no exceptions.**

1. From every SvelteKit route file, following runtime imports, the renderer reaches no module under a `server/` folder, no file under `electron/`, no Node built-in and no main-process package. The main-process packages are `electron`, Playwright, PGlite, onnxruntime, tesseract.js, sherpa-onnx and mpg123-decoder.
2. No production module under `src/` loads the `electron` package.

Runtime imports are read with the TypeScript parser. `import type` and `export type` count as erased everywhere. A named import whose names are all types (`import { type A } from "x"`) counts as erased only in a `.svelte` file. Under the repo's `verbatimModuleSyntax`, a `.ts` file keeps it as `import "x"`, so the module still loads.

The check follows static, side-effect, re-export, `export *`, `import()`, `require()` and `new URL(…, import.meta.url)` references. It refuses three things instead of skipping them: a computed `import()` or `require()`, an `import.meta.glob` that can match code, and a path that names no file. Without that, a whole subtree could pass unchecked.

`.svelte` files are read from their `<script>` blocks. The entries are the route files, without `*.server.ts` and `+server.ts`, plus any client hooks. A violation prints the import chain from the route.

**Shared contracts live outside `server/`.** The Error report's types and note limit moved to `src/lib/automation/error-report-contract.ts`, and the server module imports them from there.

## Considered options

- **ESLint with an import-boundaries plugin.** Rejected for now. The repo runs no ESLint, and the rules need the route graph, not folder globs.
- **Rules for ledger, lib and workflows directions.** Deferred until those modules are separated. A rule that starts with dozens of exceptions does not hold a boundary. [ADR 0131](0131-the-ledger-never-names-a-workflow-module.md) adds the ledger → workflows rule.
