# Persistent Data-Issue Resolution Design

Date: 2026-07-20
Status: Approved in conversation; awaiting written-spec review

## Goal

Replace the renderer-only data-issue prototype with a persistent, reversible workflow that lets a user report an incorrect account value, identify the exact CSV import version that introduced it, preview the system-wide impact, and exclude that import without deleting ledger data.

## Privacy requirement

All committed fixtures, tests, screenshots, logs, and documentation use fictional institutions, masked account identifiers, and synthetic amounts. The known production incident is not copied into source code or test data.

## Confirmed product decisions

- Exclusion scope is one complete CSV version, identified by `(source_file_id, import_run_id)`.
- Only physical ledger rows inserted by that source version are excluded. Rows skipped as duplicates remain available through their existing source.
- Reimporting identical content does not reactivate excluded rows.
- Corrected content may import as new active rows.
- Exclusion may proceed even when an affected account has no replacement data.
- An account without active data remains visible as `無可用資料` and is excluded from totals, charts, and exposure percentages.
- Restore is blocked if the affected account received newer active data after exclusion.
- All successful, blocked, and failed operations are retained as append-only events and remain visible in the interface.

## Architecture

Keep imported rows immutable. Add persistent source-version history, data-issue cases, source exclusions, and append-only events. A shared ledger filtering boundary removes rows belonging to active exclusions before any account, transaction, balance, history, spending, or overview model is calculated.

The renderer never selects database tables or submits row identifiers. It sends case IDs, source-version IDs, reasons, acknowledgements, and preview tokens through typed desktop IPC. The main-process service resolves the actual scope and performs every mutation in a SQLite transaction.

## Persistence model

### `source_file_imports`

Append one row for every CSV processed by an import run. This preserves source-version metadata that the current path-keyed `source_files` upsert overwrites.

Required fields:

- `source_file_id`
- `import_run_id`
- `source_relative_path`
- `source_file_hash`
- `source_file_bytes`
- `source_file_modified_at`
- `imported_at`
- `bank`
- `product`
- `row_count`
- `status`
- `record_json`

Primary key: `(source_file_id, import_run_id)`.

Migration backfills the currently retained `source_files` version. Future imports append to `source_file_imports` in the same transaction as statement rows and keep updating `source_files` for existing consumers.

### `data_issues`

Stores the reported context and current workflow state.

Required fields:

- `data_issue_id`
- `account_id`
- `account_label`
- `field_key`
- `reported_value`
- `currency`
- `data_date`
- `note`
- `status`: `pending`, `investigating`, `resolved`, or `restored`
- `created_at`
- `updated_at`

Submitting the report creates the case with `pending`. Opening diagnosis changes it to `investigating`. Successful exclusion changes it to `resolved`. Successful restore changes it to `restored`.

### `disabled_import_sources`

Stores reversible exclusion state for one source version.

Required fields:

- `disabled_import_source_id`
- `data_issue_id`
- `source_file_id`
- `import_run_id`
- `reason`
- `state`: `active` or `restored`
- `disabled_at`
- `restored_at`
- `preview_token`

Unique key: `(source_file_id, import_run_id)`. Repeated confirmation is idempotent. State changes are always accompanied by a new event.

### `data_issue_events`

Append-only audit and error history.

Required fields:

- `data_issue_event_id`
- `data_issue_id`
- `event_type`
- `stage`
- `outcome`: `succeeded`, `blocked`, or `failed`
- `summary`
- `details_json`
- `created_at`

Events cover report creation, diagnosis start, preview, exclusion, restore preview, restore, and every failure. Technical details use stable error codes and safe messages; they must not include credentials, cookies, or full local paths.

## Active-ledger filtering

Add one shared function that applies active exclusions to `LedgerQueryData` before downstream model builders run. It matches typed statement rows using `(source_file_id, import_run_id)`.

Every loader that builds overview, asset, liability, spending, account history, or chart data must load the active exclusions and pass filtered data to existing pure model functions. Page-specific exclusion conditions are not allowed.

Credit-card captures require derived filtering:

1. Filter credit-card statement rows by active exclusions.
2. Remove capture entries whose statement row is no longer active.
3. Treat an incomplete capture as unavailable.
4. Reuse the existing latest-complete-capture selection to fall back to the preceding valid capture.

The same shared result drives account values, transactions, totals, histories, and charts so one exclusion cannot produce conflicting pages.

## Reporting and diagnosis flow

1. The user opens `回報資料問題` from the account-row warning icon.
2. Submission creates `data_issues` and a `reported` event in one transaction, then navigates to the case.
3. Diagnosis derives candidate source versions from rows currently contributing to the reported account.
4. The user selects one source version. The backend finds physical rows with the selected `(source_file_id, import_run_id)` across supported statement tables.
5. Preview calculates the before and after ledger from one read snapshot and returns:
   - account values before and after;
   - excluded physical row count;
   - duplicate rows retained through other imports;
   - all affected accounts;
   - accounts that become `無可用資料`;
   - a preview token representing the input ledger and selected source version.
6. Confirmation reruns preview inside the write transaction. A stale token blocks the action and creates an event.
7. Successful confirmation activates `disabled_import_sources`, appends an event, and resolves the case in the same transaction.
8. The renderer reloads persisted data through the existing page APIs.

## Identical and corrected reimports

Identical rows continue to hit the existing content-hash uniqueness rules, so their physical identity remains attached to the excluded source version and they remain inactive. A corrected CSV may insert rows with new content hashes under a new import run; those rows are active unless that source version is separately excluded.

The importer must append `source_file_imports` even when all statement rows are duplicates, preserving an audit record of the repeated import attempt.

## Missing active account data

An exclusion is allowed when no replacement position remains. The account identity is retained from the reported case or known account metadata. Its amount is represented as unavailable, not zero.

Unavailable accounts:

- remain in account lists;
- show `無可用資料` and the related case link;
- do not contribute to totals, charts, daily history, or exposure percentages;
- retain transaction history only for rows that remain active.

## Restore rules

Restore always starts with a fresh backend preview. It is blocked when any affected account has newer active data than the exclusion timestamp. The blocked attempt appends an event and leaves both the case and exclusion unchanged.

If no newer active data exists, restore changes the exclusion state to `restored`, changes the case to `restored`, and appends an event in one transaction. No imported row is rewritten.

## Error handling and atomicity

- Preview is read-only and records failures without changing ledger visibility.
- Exclusion and restore use `BEGIN`, `COMMIT`, and `ROLLBACK` around state and event writes.
- Confirmation rejects unknown cases, unknown source versions, missing acknowledgement, blank reasons, stale preview tokens, invalid state transitions, and concurrent conflicting changes.
- UI submission is disabled while a request is running, but backend idempotency remains authoritative.
- A failed operation preserves the selected source, reason, and acknowledgement in renderer state.
- All caught service failures attempt to append a safe failed event. If the database is unavailable, the UI shows the failure immediately; persistence is retried only through an explicit user retry, not a background loop.

## Desktop API

Add a typed `dataIssues` namespace with operations equivalent to:

- `list()`
- `create(report)`
- `load(dataIssueId)`
- `startDiagnosis(dataIssueId)`
- `previewExclusion({ dataIssueId, sourceVersionId })`
- `confirmExclusion({ dataIssueId, sourceVersionId, reason, acknowledged, previewToken })`
- `previewRestore(dataIssueId)`
- `confirmRestore({ dataIssueId, previewToken })`

Exact DTOs are defined in the implementation plan. IPC validates all inputs and never accepts raw SQL, table names, or arbitrary row IDs.

## Interface

- Keep the warning-icon entry on account rows.
- The Data Issues destination lists cases and filters them by `待處理`, `調查中`, `已解決`, and `已還原`.
- Case detail retains the approved single-card progressive flow:
  1. `回報內容`
  2. `確認來源`
  3. `預覽影響`
  4. `確認排除`
- Do not restore the removed breadcrumb, page-level status chip, or error banner.
- An error appears inline in the stage where it occurred with time, readable summary, and expandable technical details.
- `操作紀錄` at the bottom shows all succeeded, blocked, and failed events after refresh.
- Accounts with no active value show `無可用資料` and link to the responsible case.
- Restore controls show the blocking reason and relevant update date when newer data prevents restoration.
- Preserve the existing slide transition and reduced-motion behavior.

## Security and validation

- Validate every renderer input at the main-process trust boundary.
- Limit reason and note lengths before persistence.
- Use generated IDs and backend timestamps.
- Escape all displayed text through normal Svelte rendering.
- Keep original CSV files and ledger rows immutable.
- Store safe error details only; omit credentials, session data, cookies, and absolute paths.
- This is a local single-user desktop workflow. Multi-user authorization and cloud synchronization are out of scope.

## Testing

### Migration checks

- Create all four tables, indexes, uniqueness rules, and status constraints.
- Backfill the current source-file version without duplicating it on repeated migration.

### Importer checks

- Append a source version for every processed CSV, including duplicate-only imports.
- Keep identical reimports excluded.
- Allow corrected content to create active rows.
- Roll back source-version history with the rest of a failed import.

### Service checks

- Create a pending case and append its first event atomically.
- Derive candidate sources from active account rows.
- Preview all affected accounts and unavailable values without mutation.
- Reject stale tokens and invalid transitions.
- Make repeated confirmation idempotent.
- Roll back on database failure.
- Block restore after newer active account data.
- Restore safely when no newer data exists.

### Shared-ledger checks

- Apply one exclusion consistently to overview, assets, liabilities, spending, account transactions, totals, histories, and charts.
- Fall back from an invalidated credit-card capture to the preceding complete capture.
- Preserve unavailable account identity while excluding it from numeric aggregation.

### IPC and UI checks

- Validate channel allowlists, payloads, DTO serialization, loading locks, disabled actions, inline errors, persistent operation history, and unavailable-account rendering.
- Preserve keyboard operation, focus behavior, accessible names, and reduced motion.

### Electron regression

Use fictional bank names, masked accounts, synthetic dates, and synthetic amounts. Verify report → pending → diagnosis → preview → exclusion, then restart the app and confirm the result persists. Verify that a failed operation records an error without changing the active ledger.

## Out of scope

- Automatic anomaly detection or automatic source selection.
- Direct CSV editing or deletion.
- Automatic restore.
- Multi-user roles or approval chains.
- Cloud synchronization.
- Background retry of failed mutations.
- Changes to browser-capture workflows unrelated to source-version persistence.
