# Ledger Physical Deduplication Design

## Goal

Store only one typed statement row for identical imported CSV content, preserve the account values currently produced after duplicate filtering, and remove duplicate-only APIs and columns in controlled migrations.

## Canonical Row

Rows are duplicates when they have the same `content_hash` within a typed statement table. The retained row is the earliest occurrence by this deterministic ordering:

1. `imported_at ASC`
2. `source_relative_path ASC`
3. `source_row_index ASC`
4. `statement_row_id ASC`

This preserves the row that current imports mark as `unique`. Because duplicate rows have the same content hash, removing later occurrences must not change typed financial values. The tie-breakers make legacy cleanup repeatable when timestamps match.

## Database Integrity

The first migration processes every table in `TYPED_STATEMENT_TABLES` in one transaction. For each table it deletes all but the canonical row in every `content_hash` partition, then creates a unique index on `content_hash`. Any failure rolls back the complete migration.

SQLite owns the invariant. Import code may use an in-memory set to avoid unnecessary statements, but correctness must not depend on that set. Inserts that conflict only with the content-hash unique index are counted as skipped duplicates. Other constraint or SQLite errors remain fatal and roll back the import run.

Personal invoices remain an explicit exception. `personal_invoices` and `personal_invoice_items` keep their existing `invoice_key` and `item_key` upsert behavior because reimport can refresh the same invoice and must preserve user-managed item categories. This is entity updating, not occurrence retention.

## Import Data Flow

The importer stops creating or writing `dedupeStatus`. For ordinary typed statement rows, each successful insert increments `importedRows`; a content-hash conflict increments `skippedDuplicateRows`. Duplicates found earlier in the same CSV import follow the same rule and never reach durable storage.

`skippedDuplicateRows` is stored in the import run and completed import event. It is diagnostic aggregate data only: no duplicate row payload or provenance occurrence is retained, and no Electron UI is added for it.

Existing meanings of `scannedCsvFiles`, `importedCsvFiles`, `skippedCsvFiles`, and `sourceFilesWritten` remain unchanged. Import result callers receive `skippedDuplicateRows` so automated checks can verify the behavior.

## Consumer Cleanup

Once the first migration guarantees physical uniqueness:

- Account overview builders process all stored rows directly; `isUnique()` and its five call sites are removed.
- `BuildFinancialDashboardInput.includeDuplicates` is removed.
- The financial model no longer branches on `dedupeStatus`.
- `counts.rawRows`, `counts.uniqueRows`, and `counts.duplicateRows` are removed because they have no renderer or other consumer.
- `dedupeStatus` is removed from repository row classes, shared types, mock builders, and checks.

Normalized transaction deduplication remains in place. Its semantic transaction key can merge distinct source rows and is separate from exact imported-content deduplication.

## Column Retirement

A second migration rebuilds typed statement tables without:

- `dedupe_status`, which becomes constant after physical deduplication.
- `raw_row_hash`, which has no production reader and is redundant with retained identity and raw payload data.

The rebuild preserves every table-specific column, primary key, foreign key, named index, and unique constraint. It runs transactionally and is covered by schema checks.

The following columns remain:

- `content_hash`: durable exact-content identity and unique key.
- `source_hash`: used to map model objects back to retained source rows.
- `raw_payload_json`: required for audit, reparsing, and existing migrations.
- `imported_at`: canonical-row ordering and provenance.
- `created_at`: left unchanged to avoid expanding this work into timestamp-semantics cleanup.
- `source_file_id`, `source_relative_path`, `bank`, and `product`: retained because removing their denormalization would require broad query joins for little expected storage gain.

Further column removal requires separate usage evidence and migration design.

## Error Handling

- Legacy cleanup and schema changes are atomic.
- Import conflict handling must identify the expected content-hash uniqueness conflict rather than suppress every insert error.
- Any parsing, foreign-key, check-constraint, or unexpected SQLite error rolls back the import transaction.
- Re-running migrations is safe through the existing migration-version mechanism.

## Verification

Focused checks must prove:

1. Legacy duplicate groups retain exactly the deterministic earliest row.
2. Unique indexes exist on all ordinary typed statement tables after migration.
3. Account overview values and positions match before and after legacy cleanup.
4. Reimporting an identical CSV does not increase typed row counts.
5. Duplicate rows within one import also retain only the first occurrence.
6. `skippedDuplicateRows` reports database and same-import duplicates accurately.
7. An unrelated insert constraint error still aborts and rolls back the import.
8. Personal invoice refresh and category-preservation behavior remains unchanged.
9. The column-retirement migration removes only `dedupe_status` and `raw_row_hash` while preserving table-specific schema objects.
10. TypeScript compilation and the Electron production build succeed.

No new dependency, UI, duplicate-history table, or compatibility abstraction is introduced.
