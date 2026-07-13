# Credit Card Capture Links Design

## Goal

Keep all captured credit-card evidence without multiplying identical transaction
payloads, show only the most recent verified complete capture as transaction
history, and calculate balances from that same capture's unbilled rows.

## Problem

Bank statement rows have no durable transaction identifier. A key based on card,
date, description, and amount can collide for two real purchases. The existing
semantic key also contains billed/unbilled state, so a state transition is stored
as two unrelated rows. Retaining the earliest row then makes the UI stale.

## Capture Contract

A workflow creates one `capture_id` and one `captured_at` value for all its
billed and unbilled files. A capture is `verified_complete` only after the
workflow has read every result page, proven the terminal page state, and matched
the merged unique row count with the bank's declared total.

Each sidecar contains the shared capture identifiers, status kind, expected row
counts per card, and the set of billed/unbilled files belonging to the capture.
The importer rejects the whole capture when either status file is absent or its
count is not validated. Partial, failed, or legacy captures remain source
evidence but never change account display or balances.

## Storage Model

`credit_card_statement_lines` becomes a canonical payload store. A normalized
`content_key` excludes query period, source path, import time, and row index.
It includes displayed transaction content, including billed/unbilled state.

Rows that have identical content within one capture receive an
`occurrence_index`, assigned from their stable source-row order within that
content group. The canonical uniqueness is `content_key + occurrence_index`.
This preserves two genuine identical purchases while avoiding a new wide payload
record whenever an unchanged row appears in another capture.

`credit_card_captures` records each verified complete capture. A
`credit_card_capture_entries` table links every source occurrence in a capture
to its canonical payload, including `source_file_id` and `source_row_index`.
Canonical rows record first/last capture timestamps for diagnostics; entries are
the authoritative membership history.

`credit_card_snapshots` remains a compact per-capture, per-card, per-status
aggregate. It retains all future verified captures. It is not populated from
partial or legacy inputs.

## Read Rules

For each bank/product/card, the UI selects the most recent verified complete
capture by `captured_at`, then `capture_id`.

- Transaction history reads that capture's entries. It therefore shows a single
  current billed/unbilled state from the bank, including genuine identical rows.
- Current card balance sums TWD values from the same capture's `unbilled`
  entries. Billed entries do not contribute.
- Balance history reads every verified complete capture aggregate. Capture time,
  not just calendar date, distinguishes multiple captures on the same day.

Legacy statement rows and snapshots remain stored for audit, but are not marked
verified and are excluded from the new display path. The first verified capture
becomes the first authoritative history point.

## Migration and Recovery

The migration is transactional. It adds capture tables and columns, removes the
credit-card semantic unique index, and leaves existing source files, statement
rows, and legacy snapshots intact. It does not overwrite the active ledger from
`~/Library/Application Support/OctopusBeak/temp` and never removes that backup.

The `temp` ledger is read-only recovery material. It may be consulted only if a
future explicit recovery is required; before any restore, the current active
ledger must be copied to a new timestamped backup and the restore/merge plan
must be confirmed by the user.

## Workflow Discovery and Validation

Use Libretto to inspect the live Esun, Fubon, and Yuanta credit-card result
pages. For each bank, record the total-count source, next/last-page signal,
page-change signal, and all-card/status coverage needed for a complete capture.
If CAPTCHA appears, stop at that state for the user to complete it before
continuing. Do not guess selectors or treat a single visible page as complete.

Each workflow receives a fixture-backed pure completeness check. Importer and
read-model checks cover identical rows, billed-to-unbilled transitions, rejected
partial captures, current transaction display, current balance, and multiple
verified capture history points on one day.

## Non-goals

- Reclassifying legacy partial captures as verified.
- Removing historical raw source evidence or the `temp` backup.
- Inferring a bank transaction identifier that the bank does not expose.
