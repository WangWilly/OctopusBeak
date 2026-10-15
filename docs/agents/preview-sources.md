# Building on Preview Sources

Status: Current

A Preview Source collects balances and transactions for an Institution that no live-verified source contract covers. Its data goes to separate preview tables and never reaches canonical admission. See [ADR 0047](../adr/0047-preview-sources-outside-canonical-admission.md) for the decision and `CONTEXT.md` for the terms *Preview features*, *Preview source*, and *Preview financial data*.

This guide describes the seam that display, structure-report, and connector work builds on. Do not edit canonical admission, Source Capture, or source contract catalog code for preview work.

## Invariants

- Preview data is written only to `preview_accounts`, `preview_balance_observations`, and `preview_transactions`. These tables live in the App's PGlite database and are created by the `preview-financial-data-v1` operational migration.
- A row without an ISO 4217 currency is refused. Amounts are exact decimal strings such as `"1234.50"`, never numbers. Both the port and the table `CHECK` constraints enforce this.
- A transaction direction is `inflow`, `outflow`, or `unknown`. Use `unknown` when the source does not say. Never infer a direction from the sign.
- A preview workflow never receives `financialCommit`. Its context has a `preview` writer bound to its own source.
- When the Preview features setting is off, preview sources are absent from sign-in settings, Sync all, Scheduled Collection, and direct runs. Their data is excluded from every read and is retained.
- While an enabled verified source covers the same Institution and product, the preview source is hidden, is not collected, and its data is not read.

## The seam

| Need | Use | File |
| --- | --- | --- |
| Register a source | Add a `PreviewSource` to `PRODUCTION_PREVIEW_SOURCES` | `src/lib/preview-sources/registry.ts` |
| Write collected data | `context.preview.write(collection)` inside `PreviewSource.run` | `src/lib/preview-sources/workflow.ts` |
| Data shapes | `PreviewCollection`, `PreviewAccount`, `PreviewBalanceObservation`, `PreviewTransaction` | `src/ledger/pglite/preview-financial-data.ts` |
| Decide what is visible | `currentPreviewVisibility()` in the main process, or the pure `previewVisibility(...)` | `src/lib/automation/server/settings.ts`, `src/lib/preview-sources/visibility.ts` |
| Read preview data | `preview.accounts(visibility)` and `preview.transactions(visibility, previewAccountId)` on the operational provider | `electron/pglite-operational-rpc.ts` |
| Verified coverage | `VERIFIED_SOURCE_COVERAGE`, keyed by verified credential group | `src/lib/preview-sources/visibility.ts` |
| Delete all preview data | `settings.deletePreviewData()` in the renderer, `deleteAllPreviewData` in main | `src/lib/preview-sources/delete-preview-data.ts` |
| Record a response for a structure report | `context.preview.observe({ endpoint, status, body })` inside `PreviewSource.run` | `src/lib/preview-sources/workflow.ts` |
| Sanitize, bound, and share a report | `previewResponseShapes`, `previewStructureReports`, `previewStructureReportIssueUrl` | `src/lib/preview-sources/structure-report.ts` |

`PreviewVisibility` is the single query-level predicate: `{ sourceIds }`. A read returns rows only for the listed sources, and an empty list returns nothing. Always compute it with `currentPreviewVisibility()` at read time, then pass it to the read. Do not cache it across a settings change; the App marks data stale (`preview-data-changed`) when the toggle changes or preview data is deleted.

The main process reaches the port as `pgliteOperational.provider.preview`. A workflow child reaches the same port through the authenticated child RPC, and the runtime injects it only into definitions with `requiresPreviewWrite: true`.

## Structure reports

When a preview run fails, the workflow worker takes the observed responses with `takePreviewObservations(error)` and turns them into shape-only inventories with the E.SUN deposit probe's sanitizer (`src/lib/preview-sources/response-shape.ts`). Raw bodies never leave the worker. The failed frame carries only the inventories, and the main process validates them again before it accepts them.

The main process keeps one report per preview task, in memory, for the latest run of that task. A new run of the task drops the previous report, and a restart drops all of them. Reports are not written to the database. The report holds at most 50 responses and at most 48,000 characters of inventories, so it fits in a GitHub issue body; older responses are dropped first and counted in `omittedResponses`.

The run details show 「分享結構報告」 for a failed preview run. The dialog shows the full report, copies it, and opens a prefilled issue in the system browser. The issue URL carries a fixed title and template only, never the report. The App never sends the report itself.

## Add a bank

1. Create `src/lib/preview-sources/<bank>-source.ts` and export a `PreviewSource`:
   - `id` is lowercase kebab-case, such as `nextbank-deposit`. The task and workflow id become `preview-<id>`, and the enabled setting becomes `PREVIEW_<ID>_ENABLED`.
   - `institution` is an `InstitutionKey` from `src/lib/institutions/institution-tables.generated.ts`, such as `bank-823`. `product` is `deposit`.
   - Every credential field key starts with `PREVIEW_<ID>_`, for example `PREVIEW_NEXTBANK_DEPOSIT_PASSWORD`.
   - `startUrl` uses `https:`.
   - `run(context, input)` signs in with `input.credentials[<key>]`, collects, validates, and returns `await context.preview.write(collection)`.
2. Add the source to `PRODUCTION_PREVIEW_SOURCES` in `registry.ts`. The App derives the sign-in group, the task, the workflow registration, and the Sync all and Scheduled Collection membership from this entry.
3. If a verified source for the same Institution and product exists, confirm that `VERIFIED_SOURCE_COVERAGE` lists it. Otherwise the preview source stays visible beside it.
4. Add a `<bank>-source.check.ts` that runs `previewWorkflowDefinition(source)` through `createWorkflowExecutor` with a fake `previewWrite` port and fixture responses. Assert the written collection, and that a missing currency or malformed amount fails before `write`.

`assertPreviewRegistry` runs when `tasks.ts` loads. It rejects a duplicate id, a credential key outside the source's prefix, and a non-https start URL.

## Test fixture

Set `OCTOPUSBEAK_PREVIEW_SOURCE_FIXTURE=1` to register the synthetic source in `src/lib/preview-sources/fixture-source.ts`. Its id is `synthetic`. It writes one fixed account without using the page. Its start URL does not resolve, so use it in checks and CDP screenshots, not for an App run. It never ships enabled.

## Promotion

When a verified contract replaces a preview source, delete that source's preview data and recollect through canonical admission. Do not migrate preview rows into canonical tables.
