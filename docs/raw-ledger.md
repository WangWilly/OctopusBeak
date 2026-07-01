# Raw Ledger Contract

Current scope: turn `downloads/` into a replayable, auditable, deduplicated local ledger.

This layer ingests source CSV files and writes typed statement rows. It must not calculate dashboard balances, pair transfers, reconcile credit card payments, or infer categories.

## Inputs

- Scan only `downloads/**/*.csv`.
- Do not parse `.xls`, `.xlsx`, or PDFs.
- If a same-stem `.json` exists beside a CSV, parse it as optional source metadata for that CSV. The importer does not scan JSON files as ledger inputs.

## CSV Layout Normalization

Downloaded CSV files are not all simple first-row-header tables. Some bank exports include report titles, query parameters, account metadata, or result-section labels before the actual table.

Before writing rows, the importer establishes the header/data boundary for each CSV:

- `first-row-header`: the first row is the table header.
- `empty-or-metadata`: the CSV has no usable transaction table.

The current importer is intentionally conservative: it treats row 1 as the header when row 1 has data, and records empty files as metadata-only. Blank or duplicate headers are converted into stable record keys such as `column_1` or `Name__2`. Statement rows use the original 1-based CSV row number in `sourceRowIndex`, so a row remains traceable to the source file.

This normalization only establishes the row/header boundary. It does not rename columns into a shared accounting model, infer categories, calculate balances, pair transfers, or reconcile card payments.

## Outputs

The current importer writes to `data/ledger/ledger.sqlite`.

Core import metadata is stored in:

- `import_run_events`
- `import_runs`
- `source_files`

Typed statement rows are stored in tables such as:

- `account_transactions`
- `foreign_currency_transactions`
- `credit_card_statement_lines`
- `loan_transactions`
- `fund_*`
- `brokerage_*`
- `unsupported_statement_rows`

MAX/MaiCoin API sync writes:

- `maicoin_sync_runs`
- `maicoin_account_snapshots`
- `maicoin_statement_rows`

The automation panel writes task history to:

- `automation_task_runs`

`data/` is ignored by git because it can contain personal financial data. Schema changes are applied through SQLite migrations.

## Replay Semantics

The importer is append-only. Re-running inputs should not delete or rewrite prior rows.

Each run has an `importRunId`. Each imported CSV has a `sourceFileId`. Each parsed CSV row has a `statementRowId`.

If `source_files` already contains the same `sourceRelativePath`, that CSV is skipped for the current run. Rows from new files are still written even when their content was seen before; those rows are marked with `dedupeStatus: "duplicate"`.

`sourceHash` is a conservative replay key based on source path, source file hash, source row index, and raw row hash. `contentHash` is based on bank, product, and raw row payload, and drives duplicate marking across imported rows.

Imports fail when no CSV files match the scan and filters.

Run lifecycle events are append-only. A formal import writes a `started` event before scanning files, a `completed` event after all run, source file, and typed row records have been appended, and a `failed` event if the import process throws after the run starts. A `started` event without a matching `completed` or `failed` event indicates an interrupted process.

## Audit Fields

Each run event records:

- `schemaVersion`
- `recordType`
- `importerName`
- `importerVersion`
- `importRunId`
- `eventType`
- `eventAt`
- run input fields for `started` events
- run count fields for `completed` events
- active source file and error fields for `failed` events

Each run records:

- `schemaVersion`
- `recordType`
- `importerName`
- `importerVersion`
- `importRunId`
- `startedAt`
- `finishedAt`
- `downloadsDir`
- `outputDir`
- `bankFilters`
- `productFilters`
- `scannedCsvFiles`
- `importedCsvFiles`
- `skippedCsvFiles`
- `importedRows`
- `sourceFilesWritten`
- `sqlitePath`

Each batch records:

- `schemaVersion`
- `recordType`
- `importerName`
- `importerVersion`
- `importRunId`
- `importBatchId`
- `sourceFile`
- `sourceRelativePath`
- `sourceFileMetadata`
- `sourceFileBytes`
- `sourceFileModifiedAt`
- `importedAt`
- `sourceMetadata`
- `sourceFileHash`
- `bank`
- `product`
- `sourceSheetName`
- `csvLayout`
- `headers`
- `recordKeys`
- `rowCount`

Each typed statement row records:

- `schemaVersion`
- `recordType`
- `importerName`
- `importerVersion`
- `importRunId`
- `statementRowId`
- `sourceFileId`
- `sourceRelativePath`
- `sourceRowIndex`
- `sourceHash`
- `rawRowHash`
- `contentHash`
- `bank`
- `product`
- `dedupeStatus`
- `rawPayload`
- parsed fields for the target typed table

## Non-Goals

- No normalized transaction model.
- No balance calculation.
- No transfer matching.
- No credit card payment reconciliation.
- No category inference.
- No dashboard or reporting layer.
