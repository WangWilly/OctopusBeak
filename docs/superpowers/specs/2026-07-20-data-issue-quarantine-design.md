# Data Issue Reporting and Reversible Import Quarantine

Date: 2026-07-20
Status: Approved for prototype planning

## Goal

Let a user report an incorrect value from an account screen, trace that value to its source CSV imports, preview the exact effect of disabling one import, disable it without losing provenance, and restore it later.

The flow must work across all ledger CSV products that use the shared import provenance fields. It must not be specific to Yuanta loan statements.

## Confirmed scope

- Add a `Report data problem` action to account details.
- Create a user-reported data issue containing the account, field, displayed value, data date, page context, and optional note.
- Add a `Data issues` navigation destination listing user-created cases.
- Show source lineage for the reported value without automatically selecting a suspicious import.
- Let the user select a source import and run a read-only impact preview.
- Allow reversible quarantine only when all affected rows can be resolved safely.
- Preserve raw CSV files, source-file records, audit history, and restoration capability.
- Recompute and display the affected account after quarantine or restoration.

## Explicit non-goals

- No automatic anomaly detection, risk scoring, background scanning, or AI confidence score.
- No automatic selection or quarantine of an import.
- No hard deletion in this flow.
- No replacement/overwrite semantics for newer CSV files.
- No product-specific cleanup rules in the frontend.

## User flow

1. From an account detail screen, the user chooses `Report data problem`.
2. A dialog captures immutable page context and an optional note.
3. The app creates a case with status `open` and opens its diagnosis page.
4. The diagnosis page shows the reported value timeline and only the imports connected to that value.
5. The user selects an import and requests an impact preview.
6. The backend resolves source occurrences and simulates the active ledger without that import.
7. The preview compares current and proposed account values and separates removed, retained-by-other-source, and unresolved rows.
8. Quarantine is enabled only when unresolved rows equal zero and the simulation succeeds.
9. The user supplies a reason, acknowledges the preview, and confirms.
10. One database transaction records the action, marks the source invalid, applies the active-data change, and closes the case.
11. The success screen shows the recomputed value and offers account, audit-log, and restore actions.
12. Restore repeats the preview and confirmation process before reversing the quarantine.

## Information architecture

### Account detail

Add secondary actions:

- View transactions
- View data sources
- Report data problem

### Data issues

Add a `data-issues` route and sidebar item. It contains only user-created cases, grouped by:

- Open
- Investigating
- Resolved
- Restored

It does not show inferred or automatically generated alerts.

### Case diagnosis

Show:

- Reported account, field, value, date, and note
- Value timeline with the reported point highlighted
- Imports that contributed to the displayed value
- Per-import file rows, inserted rows, skipped duplicates, affected accounts, and import time
- Original source-row inspection
- A user-controlled import selection

### Impact preview

Show a current-versus-proposed comparison plus:

- Rows removed from active data
- Rows retained because another active source supports them
- Unresolved rows
- Affected accounts and screens
- Required reason and acknowledgement

The quarantine action is disabled when the source file is unavailable, lineage is incomplete, simulation fails, or any row is unresolved.

### Completion and restoration

Show the recomputed reported value, row counts, case status, audit event, and a reversible `Restore this import` action. Restore never executes without its own preview.

## Data model

The existing `source_files.status` column becomes the source-of-truth for whether an import is active. Valid states for this feature are `completed` and `invalidated`.

Add `data_issues`:

```text
issue_id
status
account_identity
field_key
displayed_value_json
data_date
route
context_json
note
created_at
resolved_at
resolution_action_id
```

Add `source_row_occurrences` so physical content deduplication does not discard source membership:

```text
source_file_id
source_row_index
table_name
content_hash
canonical_row_id
created_at
PRIMARY KEY (source_file_id, source_row_index, table_name)
```

Every parsed row records an occurrence, including rows skipped as physical duplicates. Existing source files are backfilled by reparsing their preserved CSV files. If a historical source is missing or cannot be parsed, its lineage remains incomplete and quarantine fails closed.

Add `import_quarantine_actions`:

```text
action_id
source_file_id
issue_id
action_type        -- invalidate | restore
reason
preview_json
performed_at
```

No row payload is destroyed. Source records and raw CSVs remain available for audit and restoration.

## Active-data semantics

A canonical typed row is active when at least one occurrence points to it from a source whose status is `completed`.

When an import is invalidated:

- An occurrence supported by another active source remains visible.
- A canonical row with no remaining active occurrence is excluded from active reads.
- The owning source record remains present with status `invalidated`.
- Any derived snapshot, capture, balance history, or aggregate affected by the active-row change is rebuilt or invalidated in the same transaction.

The implementation plan must choose one shared active-row boundary for all dashboard reads. Product-specific frontend filters are prohibited because they are easy to omit. The preferred boundary is a shared repository/query helper or active-row database views reused by every ledger read path.

## Backend operations

Expose the minimum desktop API required by the UI:

```text
dataIssues.list()
dataIssues.create(report)
dataIssues.load(issueId)
dataIssues.previewQuarantine(issueId, sourceFileId)
dataIssues.quarantine(issueId, sourceFileId, reason, previewToken)
dataIssues.previewRestore(actionId)
dataIssues.restore(actionId, reason, previewToken)
```

Preview returns a short-lived token bound to the source status and database revision. Confirmation rejects a stale token so the executed result cannot differ silently from the displayed preview.

Quarantine and restore run in one SQLite transaction. Any failed audit write, source-status change, lineage update, or validation rolls back the complete operation.

Each product parser may declare how its derived projections are refreshed, but it may not implement separate quarantine semantics. Source status, occurrence resolution, preview validation, audit, and rollback remain shared infrastructure.

## Frontend states

The clickable prototype covers:

1. Account detail with report action
2. Report dialog
3. Data-issue list
4. Diagnosis and source selection
5. Successful impact preview
6. Blocked preview with unresolved lineage
7. Confirmation in progress
8. Successful quarantine
9. Audit history
10. Restore preview and successful restoration
11. Transaction failure with unchanged data

The prototype reuses `DashboardShell`, existing cards, tables, buttons, spacing, typography, and modal behavior. It adds no UI dependency.

## Accessibility and safety

- Reported page context is read-only in the report dialog.
- Dialogs trap focus, close with Escape when safe, restore focus to their trigger, and expose an accessible title and description.
- Async operations announce progress and completion.
- Error messages identify the failed condition without exposing raw SQL.
- Quarantine requires a non-empty reason and explicit acknowledgement.
- Blocked previews never expose an override action.
- Restore is visually distinct from quarantine but receives the same preview safeguards.

## Verification

Smallest required checks:

- A duplicate occurrence keeps a canonical row active when one of two sources is invalidated.
- Invalidating the only active occurrence excludes the row.
- Restoring the source makes the row active again.
- An incomplete lineage preview cannot produce a confirmation token.
- A stale preview token is rejected without changing data.
- A failed transaction leaves source status, active rows, issue status, and audit history unchanged.
- Derived snapshots and aggregates contain no values supported only by an invalidated source.
- The account-level report flow preserves the exact displayed context.
- The prototype supports keyboard-only completion of the non-blocked flow.

## Prototype acceptance scenario

The seeded scenario reproduces the reported loan case:

```text
Account: 萬華 - 信貸中放 - **********1100
Reported value: 520,524
Selected source: loan-statements-<reported-import>.csv
CSV rows: 72
Rows excluded: 6
Rows retained by other sources: 66
Unresolved rows: 0
Resulting value: 354,107
```

The user can complete report, diagnosis, preview, quarantine, verification, audit inspection, and restoration from the prototype UI.
