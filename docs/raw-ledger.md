# Raw Ledger Contract

First phase scope: turn `downloads/` into a replayable, auditable, deduplicated raw ledger.

This layer only ingests source files. It must not calculate balances, pair transfers, reconcile credit card payments, or build dashboards.

## Inputs

- Scan only `downloads/**/*.csv`.
- Do not parse `.xls`, `.xlsx`, `.json`, or PDFs in this phase.
- If a same-stem `.xls`, `.xlsx`, or `.json` exists beside a CSV, record it as `relatedRawFiles`, `relatedRawFileRelativePaths`, and `relatedRawFileMetadata` for audit context. These files are hashed, not parsed.

## CSV Layout Normalization

Downloaded CSV files are not all simple first-row-header tables. Some bank exports include report titles, query parameters, account metadata, or result-section labels before the actual table.

Before writing raw rows, the importer detects the table layout for each CSV:

- `first-row-header`: the first row is the table header.
- `detected-header-row`: the CSV contains preamble rows before the table header.
- `empty-or-metadata`: the CSV has no usable transaction table.

The importer records this decision as `csvLayout` on each import batch. `csvLayout` includes the detected header row, data start row, preamble row count, detection source, and warnings. `generated-column-header` means the first row contains workflow-generated positional headers such as `column_1`; in that case rows are preserved conservatively with positional column names instead of guessing a later section header. Raw transaction occurrences use the original 1-based CSV row number in `sourceRowIndex`, so a row remains traceable to the source file even when preamble rows are skipped.

This normalization only establishes the row/header boundary. It does not rename columns into a shared accounting model, infer categories, calculate balances, pair transfers, or reconcile card payments.

## Outputs

The import appends JSONL files under `data/ledger/`:

- `import_run_events.jsonl`
- `import_runs.jsonl`
- `import_batches.jsonl`
- `raw_transaction_occurrences.jsonl`

`data/` is ignored by git because it can contain personal financial data.

All records carry `schemaVersion: "raw-ledger.v1"` so future import format changes can be handled explicitly. JSONL records also carry `recordType`, `importerName`, and `importerVersion` so their purpose and producer remain clear outside the original filename.

## Replay Semantics

The importer is append-only. Re-running the same inputs should not delete or rewrite prior rows.

Each run has an `importRunId`. Each CSV file in that run has an `importBatchId`. Each parsed CSV row has a `rawTransactionId`.

Rows that appear to have been imported before are still written as raw occurrences, but marked with `dedupeStatus: "duplicate"`. This preserves the audit trail while allowing later layers to ignore duplicates.

`sourceHash` is a conservative replay key based on the source file hash, source row index, and raw row hash. It is meant to detect the same source row being imported again. `contentHash` is based on bank, product, and raw row payload; it is retained for later analysis but does not drive first-phase duplicate marking.

Formal imports fail by default when no CSV files match the scan and filters. Use `dryRun: true` to inspect an empty scan without writing ledger files, or `allowEmpty: true` only when an empty formal run should be recorded intentionally.

Run lifecycle events are append-only. A formal import writes a `started` event before scanning files, a `completed` event after all run, batch, and raw occurrence records have been appended, and a `failed` event if the import process throws after the run starts. A `started` event without a matching `completed` or `failed` event indicates an interrupted process.

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
- `dedupeMode`
- `dryRun`
- `allowEmpty`
- `scannedCsvFiles`
- `importedRows`
- `uniqueRows`
- `duplicateRows`
- `batchesWritten`
- `runEventLogPath`
- `batchLogPath`
- `transactionLogPath`

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
- `sourceFileHash`
- `sourceFileBytes`
- `sourceFileModifiedAt`
- `importedAt`
- `relatedRawFiles`
- `relatedRawFileRelativePaths`
- `relatedRawFileMetadata`
- `bank`
- `product`
- `sourceSheetName`
- `csvLayout`
- `headers`
- `recordKeys`
- `rowCount`

Each raw transaction occurrence records:

- `schemaVersion`
- `recordType`
- `importerName`
- `importerVersion`
- `importRunId`
- `rawTransactionId`
- `importBatchId`
- `sourceFile`
- `sourceRelativePath`
- `sourceRowIndex`
- `sourceHash`
- `rawRowHash`
- `contentHash`
- `bank`
- `product`
- `dedupeStatus`
- `sourceFileHash`
- `rawPayload`

## Non-Goals

- No normalized transaction model.
- No balance calculation.
- No transfer matching.
- No credit card payment reconciliation.
- No category inference.
- No dashboard or reporting layer.
