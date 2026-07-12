# Credit Card Snapshot Integrity Design

## Goal

Run ledger migrations before the Electron UI opens, capture complete Esun credit-card results across all pages, store daily credit-card balance snapshots independently from transaction entities, and repair legacy partial-snapshot history without retaining repeated transaction payloads.

## Startup Migration

Electron startup opens the configured ledger database in writable mode before creating the browser window. The existing `openLedgerDatabase()` migration path applies pending schema versions and closes the connection immediately. Applied versions remain no-ops through `schema_migrations`.

If opening or migrating the ledger fails, startup does not create the main window and uses the existing startup-error path. Read-only page loads are no longer responsible for eventually triggering migrations.

## Complete Esun Capture

The Esun workflow must traverse every page of the statement DataGrid. It parses each page, advances through the bank's next-page control, and stops only when the UI proves that the last page has been reached. Page overlap is removed with the semantic transaction key described below.

A capture is complete only when the workflow reaches the last page and the unique parsed-row count agrees with the total count exposed by the bank UI. A missing last-page signal, inconsistent total, stalled page transition, or parse failure aborts the workflow. It must not emit a full-snapshot file.

Completed sidecar metadata adds:

```ts
snapshotMode: "full";
snapshotCapturedAt: string;
cardRowCounts: Record<string, number>;
```

Existing provenance fields remain unchanged.

## Transaction Identity

Credit-card transaction identity is a stable semantic key containing:

1. bank
2. card last four digits
3. statement type
4. consume date
5. description
6. foreign currency
7. foreign amount
8. TWD amount
9. installment action
10. payment status

`statement_period`, query dates, source path, and import time are not part of identity. Equal semantic keys retain the earliest imported transaction row.

Esun currently supplies no stable transaction sequence number. Two legitimate same-card, same-day, same-merchant, same-amount transactions therefore collide. The implementation must include a `ponytail:` comment naming this ceiling and the upgrade path: include the bank transaction sequence when the source exposes it.

## Snapshot Storage

Migration 14 creates `credit_card_snapshots`:

```text
snapshot_id TEXT PRIMARY KEY
source_file_id TEXT NOT NULL
bank TEXT NOT NULL
product TEXT NOT NULL
card_key TEXT NOT NULL
statement_type TEXT NOT NULL
captured_at TEXT NOT NULL
as_of_date TEXT NOT NULL
currency TEXT NOT NULL
transaction_count INTEGER NOT NULL
total_amount REAL NOT NULL
```

Named indexes support `(card_key, statement_type, as_of_date, captured_at)` lookup and source-file provenance. A unique constraint prevents importing the same card/type/source snapshot twice.

Importing a sidecar with `snapshotMode: "full"` groups parsed credit-card rows by card and statement type, then stores count and amount totals. Partial or legacy sidecars without a full marker do not create new snapshots during normal imports.

Daily balance history groups snapshots by card, statement type, and `as_of_date`, selecting the greatest `captured_at` for that day. It no longer infers a balance snapshot from whichever transaction source file was imported last.

## Legacy Backfill

Migration 15 evaluates existing credit-card source files before removing repeated transaction rows.

For each card, statement type, and calendar import day, it derives the semantic transaction set, count, and total for every source file. A later file that is a proper subset of an earlier same-day file is classified as partial and does not produce a snapshot. A later equal set or superset is eligible; the latest eligible capture becomes that day's balance snapshot.

This rule excludes the known Esun 8397 partial captures:

- 2026-06-30: 2 rows totaling TWD 160
- 2026-07-03: 1 row totaling TWD 142

After backfill, credit-card statement rows are deduplicated by semantic key, retaining the earliest row by `imported_at`, `source_relative_path`, `source_row_index`, then `statement_row_id`.

Snapshot provenance remains linked to `source_file_id`; snapshot history therefore survives deletion of duplicate transaction occurrences.

Legacy captures across different days are not inferred as partial merely because their row count decreases. Only same-day subset evidence is accepted. This avoids hiding a legitimate billing-cycle reset.

## Data Flow

```text
Electron start
  -> writable ledger open
  -> migrations 12-15
  -> close ledger
  -> create window

Esun workflow
  -> traverse all pages
  -> validate total and last page
  -> semantic merge of page overlap
  -> write CSV + full-snapshot sidecar
  -> importer stores transaction entities + snapshot aggregate

Overview history
  -> read credit_card_snapshots
  -> latest complete capture per card/day
  -> render daily liability balance
```

## Error Handling

- Startup migration failure prevents the main window from opening.
- Esun pagination that cannot prove completeness fails without emitting a full snapshot.
- Snapshot insertion and transaction insertion share the importer transaction.
- Unexpected SQLite errors remain fatal and roll back the import.
- Migration 15 is transactional; ambiguous cross-day legacy captures remain untouched rather than guessed.

## Verification

Checks must prove:

1. Electron starts migrations before `createWindow` and closes the database.
2. A migration failure reaches the startup-error path and creates no main window.
3. Multi-page Esun fixtures return every row and remove page overlap.
4. Missing final-page or mismatched-total fixtures fail and emit no full snapshot.
5. Full sidecars create per-card snapshot counts and totals.
6. Legacy sidecars without `snapshotMode: "full"` create no normal-import snapshot.
7. Daily history chooses the latest complete same-day snapshot.
8. Migration 15 excludes the known 6/30 and 7/3 partial files.
9. Semantic duplicate credit-card transactions retain one earliest row.
10. Personal-invoice upserts and non-credit-card content-hash uniqueness remain unchanged.
11. Typecheck, production build, and live Electron overview verification pass.

No dependency, generic snapshot framework, compatibility service, or new UI is introduced.
