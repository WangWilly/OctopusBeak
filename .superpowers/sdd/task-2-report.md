# Task 2 Report: Normalized SQLite Import

## Scope

Implemented the normalized SQLite import path for e-invoice personal invoices without touching workflow or automation files.

Files changed:

- `src/ledger/db/migrations.ts`
- `src/ledger/import-downloads-csv.ts`
- `src/ledger/import-downloads-csv.check.ts`

## TDD Record

1. Added `src/ledger/import-downloads-csv.check.ts` from the task brief.
2. Ran:

   ```bash
   node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
   ```

   Initial failure:

   - `SyntaxError: The requested module './import-downloads-csv.ts' does not provide an export named 'importDownloadsCsv'`

3. Implemented the minimal importer and schema changes.
4. Re-ran the check until green.

## Implementation Summary

### `src/ledger/db/migrations.ts`

- Added `createTypedStatementIndexesFor()` to centralize shared typed-table indexes.
- Added `createPersonalInvoiceStatementTables()` for:
  - `personal_invoices`
  - `personal_invoice_items`
- Wired personal invoice table creation into `createTypedStatementSchema()` for fresh databases.
- Added migration version `9` named `personal_invoice_statement_tables` for existing databases.

### `src/ledger/import-downloads-csv.ts`

- Exported `importDownloadsCsv(...)`.
- Added CLI entry guard with `pathToFileURL(...)` so the module can be imported by checks without auto-running `main()`.
- Imported `personalInvoiceFields()` and `personalInvoiceItemFields()`.
- Added `upsertRecord()` with conflict-column updates handled in SQLite.
- Added special-case insertion for `einvoice/personal-invoices`:
  - one row upserts `personal_invoices`
  - one row upserts `personal_invoice_items`
- Reused the existing shared typed-row common fields and existing parser context path for non-e-invoice imports.

### `src/ledger/import-downloads-csv.check.ts`

- Added the required end-to-end import check from the task brief.
- Normalized the queried result rows with object spread before deep equality checks because this Node/SQLite combination returns null-prototype row objects from `.get()`.

## Verification

Ran:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Results:

- `src/ledger/import-downloads-csv.check.ts`: passed
- `src/ledger/source-csv-parsers.check.ts`: passed

## Notes

- Did not modify workflow or automation files.
- Ignored the known stale failure in `src/lib/automation/server/automation-core.check.ts` as requested.

---

## Task 2 fix after review

### What I fixed

- Bypassed the pre-parse `source_relative_path` skip only for `einvoice/personal-invoices`, so a rewritten CSV at the same path is parsed and reaches the invoice/item upserts.
- Extended e-invoice invoice and item upserts to refresh shared provenance columns on conflict: `source_file_id`, `import_run_id`, `source_relative_path`, `source_row_index`, `source_hash`, `raw_row_hash`, `content_hash`, `dedupe_status`, `raw_payload_json`, and `imported_at`.
- Tightened `src/ledger/import-downloads-csv.check.ts` to rewrite the same CSV path, re-run import, and assert the latest `status`, `source_relative_path`, and stored raw payload for both the invoice and item rows.

### Test commands and results

- `node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts` — passed
- `node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts` — passed

### Files changed

- `src/ledger/import-downloads-csv.ts`
- `src/ledger/import-downloads-csv.check.ts`
- `.superpowers/sdd/task-2-report.md`

### Commit

- `7fcc5c0e` — `Fix einvoice same-path reimport updates`
