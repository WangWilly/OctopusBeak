# Credit-card Capture Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve credit-card capture evidence without duplicating unchanged payloads, and base current transactions/balances on the latest verified complete capture.

**Architecture:** Each workflow writes one billed and one unbilled CSV with a shared capture id and timestamp. Canonical statement rows are unique by normalized content plus occurrence index; a new entry table retains source-row membership per capture. Snapshots remain compact verified-capture aggregates.

**Tech Stack:** TypeScript, SQLite, Drizzle, Zod, Svelte, Libretto/Playwright.

## Global Constraints

- Never read, overwrite, move, or delete `~/Library/Application Support/OctopusBeak/temp`; it is rollback-only evidence.
- Preserve legacy source files, raw rows, and snapshots. They get no verified capture id and are excluded only from new UI paths.
- Future canonical identity is `(content_key, occurrence_index)`. Never deduplicate a complete capture by transaction content.
- A verified capture has exactly one billed and one unbilled sidecar with identical `captureId`, `capturedAt`, bank/product, card-key set, and `captureKinds: ["billed", "unbilled"]`.
- Incomplete/scoped/paged-unverified captures remain evidence only and cannot alter current transactions, balances, or history.
- Esun's bank-enforced query window is its latest year; do not query older dates.
- Fubon `網路繳款`, `行動銀行繳款`, and `前期應繳總額` are summary rows, never transactions or balance inputs.
- Add no dependencies. Keep Node strip-types checks and use `apply_patch` for edits.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/ledger/credit-card-capture.ts` | Shared sidecar schema and occurrence/count helpers. |
| `src/ledger/db/{migrations,schema}.ts` | Capture tables, canonical fields/index, snapshot capture id. |
| `src/ledger/import-downloads-csv.ts` | Validate pairs, canonical upsert, entries, and aggregates. |
| `src/workflows/*-credit-card-statements.ts` | Bank completeness checks and shared capture sidecars. |
| `src/lib/shared-ledger/server/accounts.ts` | Current credit-card rows/positions from verified captures. |
| `src/lib/overview/server/daily-history.ts` | One history point per verified capture timestamp. |
| `src/lib/**/components/*history*` | Preserve and show same-day capture times. |

### Task 1: Define the shared capture contract

**Files:**
- Create: `src/ledger/credit-card-capture.ts`
- Create: `src/ledger/credit-card-capture.check.ts`
- Modify: `src/ledger/credit-card-identity.ts`
- Modify: `src/ledger/credit-card-identity.check.ts`

**Interfaces:**
- Produces `fullCreditCardCaptureMetadataSchema`, `captureCardRowCounts()`, `assignOccurrenceIndexes()`, and `creditCardContentKey()`.

- [ ] **Step 1: Write the failing contract check.**

```ts
import assert from "node:assert/strict";
import { assignOccurrenceIndexes, captureCardRowCounts,
  fullCreditCardCaptureMetadataSchema } from "./credit-card-capture.ts";

const rows = [
  { cardKey: "8397", contentKey: "coffee", sourceRowIndex: 4 },
  { cardKey: "8397", contentKey: "coffee", sourceRowIndex: 9 },
];
assert.deepEqual(assignOccurrenceIndexes(rows).map((row) => row.occurrenceIndex), [0, 1]);
assert.deepEqual(captureCardRowCounts(["8397", "9170"], rows), { "8397": 2, "9170": 0 });
assert.equal(fullCreditCardCaptureMetadataSchema.parse({
  snapshotMode: "full", captureId: "9d000000-0000-4000-8000-000000000001",
  capturedAt: "2026-07-13T01:02:03.000Z", captureKinds: ["billed", "unbilled"],
  cardRowCounts: { "8397": 0 }, completenessEvidence: { bank: "esun" },
}).snapshotMode, "full");
```

- [ ] **Step 2: Run the check.**

Run: `node --no-warnings --experimental-strip-types src/ledger/credit-card-capture.check.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the smallest reusable contract.**

```ts
export const fullCreditCardCaptureMetadataSchema = z.object({
  snapshotMode: z.literal("full"),
  captureId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  captureKinds: z.tuple([z.literal("billed"), z.literal("unbilled")]),
  cardRowCounts: z.record(z.string().regex(/^\d{4}$/), z.number().int().nonnegative()),
  completenessEvidence: z.record(z.unknown()),
});

export function assignOccurrenceIndexes<T extends { contentKey: string; sourceRowIndex: number }>(rows: T[]) {
  const seen = new Map<string, number>();
  return [...rows].sort((a, b) => a.sourceRowIndex - b.sourceRowIndex).map((row) => {
    const occurrenceIndex = seen.get(row.contentKey) ?? 0;
    seen.set(row.contentKey, occurrenceIndex + 1);
    return { ...row, occurrenceIndex };
  });
}
```

`captureCardRowCounts()` initializes every supplied card key to zero then counts every source row. `creditCardContentKey()` is the existing normalized semantic identity (including status); retain `creditCardSemanticKey()` as an alias for migration-15 compatibility.

- [ ] **Step 4: Verify and commit.**

Run: `node --no-warnings --experimental-strip-types src/ledger/credit-card-capture.check.ts && node --no-warnings --experimental-strip-types src/ledger/credit-card-identity.check.ts`

Expected: PASS; status changes alter content key while path/query-period changes do not.

```bash
git add src/ledger/credit-card-capture.ts src/ledger/credit-card-capture.check.ts src/ledger/credit-card-identity.ts src/ledger/credit-card-identity.check.ts
git commit -m "feat: define credit card capture contract"
```

### Task 2: Add migration 17 and Drizzle declarations

**Files:**
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/schema.ts`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Produces `credit_card_captures`, `credit_card_capture_entries`, `capture_id` on snapshots, and `content_key`/`occurrence_index`/first-last-seen fields on statement lines.

- [ ] **Step 1: Add failing legacy-safe migration assertions.**

```ts
migrateLedgerDb(cardDb);
assert.ok(cardDb.prepare("PRAGMA table_info(credit_card_captures)").all()
  .some((column: { name: string }) => column.name === "capture_id"));
assert.equal(cardIndexes.some((index) => index.name === "uq_credit_card_statement_lines_semantic_key"), false);
assert.equal(cardDb.prepare("SELECT COUNT(*) AS count FROM credit_card_captures").get().count, 0);
assert.equal(cardDb.prepare("SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE capture_id IS NOT NULL").get().count, 0);
```

Also assert the unique content-occurrence index permits `occurrence_index` 0 and 1 for one content key but rejects a duplicate pair.

- [ ] **Step 2: Run the migration check.**

Run: `node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts`

Expected: FAIL for the missing v17 tables/index.

- [ ] **Step 3: Implement migration 17 as one transaction.**

```sql
CREATE TABLE credit_card_captures (
  capture_id TEXT PRIMARY KEY, bank TEXT NOT NULL, product TEXT NOT NULL,
  captured_at TEXT NOT NULL, completeness_json TEXT NOT NULL
);
CREATE TABLE credit_card_capture_entries (
  capture_id TEXT NOT NULL, statement_row_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL, source_row_index INTEGER NOT NULL,
  bank TEXT NOT NULL, product TEXT NOT NULL, card_key TEXT NOT NULL,
  statement_type TEXT NOT NULL CHECK (statement_type IN ('billed','unbilled')),
  PRIMARY KEY (capture_id, source_file_id, source_row_index)
);
CREATE INDEX idx_credit_card_capture_entries_latest
  ON credit_card_capture_entries(bank, product, card_key, capture_id, statement_type);
```

Add nullable `content_key`, `occurrence_index`, `first_seen_at`, `last_seen_at` and nullable snapshot `capture_id`. Backfill legacy canonical values deterministically by `imported_at, source_relative_path, source_row_index, statement_row_id`; drop only the semantic-key unique index; create `uq_credit_card_statement_lines_content_occurrence` as a partial unique index on `(content_key, occurrence_index)`. Do not create captures or entries for legacy rows and do not delete any evidence.

- [ ] **Step 4: Verify and commit.**

Run: `node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts && npm run typecheck`

Expected: PASS; legacy snapshots have null capture ids and canonical index behavior holds.

```bash
git add src/ledger/db/migrations.ts src/ledger/db/schema.ts src/ledger/db/migrations.check.ts
git commit -m "feat: add credit card capture storage"
```

### Task 3: Import capture pairs through canonical rows and entries

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts`
- Modify: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes Task 1 metadata and helpers.
- Produces capture rows, exact source-row entries, and capture-scoped snapshots only after pair validation.

- [ ] **Step 1: Replace the semantic-collision regression with pair fixtures.**

Use matching billed/unbilled JSON sidecars and assert all cases below:

```ts
assert.deepEqual(entryRows.map((row) => row.occurrence_index), [0, 1]); // two identical purchases
assert.equal(latestSnapshot.transaction_count, 2);
assert.equal(latestSnapshot.total_amount, 200);
assert.equal(statementLineCountAfterSecondIdenticalCapture, 2); // no wide duplicate
assert.equal(captureCount, 2);
assert.equal(entryCount, 4);
assert.deepEqual(latestTransactionTypes, ["billed"]); // previous unbilled state absent
assert.equal(partialCaptureCount, 0);
assert.equal(partialEntryCount, 0);
assert.equal(partialSnapshotCount, 0);
```

Retain ordinary-table duplicate behavior and the test that a non-unique SQLite error is never swallowed.

- [ ] **Step 2: Run the importer check.**

Run: `node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts`

Expected: FAIL because current code has no entries and collapses counts in a semantic-key `Map`.

- [ ] **Step 3: Replace only the credit-card insertion/snapshot path.**

```ts
function upsertCanonicalCreditCardLine(db: LedgerDatabase, row: CanonicalCreditCardRow) {
  const existing = db.prepare(`SELECT statement_row_id FROM credit_card_statement_lines
    WHERE content_key = ? AND occurrence_index = ?`).get(row.contentKey, row.occurrenceIndex);
  if (existing) {
    db.prepare("UPDATE credit_card_statement_lines SET last_seen_at = ? WHERE statement_row_id = ?")
      .run(row.seenAt, existing.statement_row_id);
    return existing.statement_row_id;
  }
  insertRecord(db, "credit_card_statement_lines", row.record);
  return row.record.statement_row_id;
}
```

Before the existing write transaction, group credit-card files by `captureId`. A group is valid only when its two kinds, timestamps, bank/product, union card keys, and actual array row counts match. Persist source files and canonical rows from legacy/partial groups as evidence, but create no capture/entry/snapshot for them. For valid groups, insert source files, canonical rows, capture, one entry per source row, and `(capture_id, card_key, statement_type)` snapshots in the existing transaction. Sum arrays, never a content-key map. Delete the uncommitted catch that treats a credit-card `semantic_key` constraint as a skipped duplicate.

- [ ] **Step 4: Verify and commit.**

Run: `node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts && node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts && npm run typecheck`

Expected: PASS; no valid import can raise `UNIQUE constraint failed: credit_card_statement_lines.semantic_key`.

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: import verified credit card captures"
```

### Task 4: Emit complete-capture sidecars and exclude Fubon payment lines

**Files:**
- Modify: `src/workflows/esun-credit-card-statements.ts`
- Modify: `src/workflows/fubon-credit-card-statements.ts`
- Modify: `src/workflows/yuanta-credit-card-statements.ts`
- Create: `src/workflows/esun-credit-card-statements.check.ts`
- Modify: `src/workflows/fubon-credit-card-statements.check.ts`
- Modify: `src/workflows/yuanta-credit-card-statements.check.ts`

**Interfaces:**
- Produces pair sidecars with a shared Task-1 contract. Scoped/failed workflows emit `snapshotMode: "partial"` evidence only.

- [ ] **Step 1: Add failing pure workflow checks.**

```ts
import { isFubonStatementSummaryRow } from "./fubon-credit-card-statements.ts";
assert.equal(isFubonStatementSummaryRow(["115/06/21", "網路繳款"]), true);
assert.equal(isFubonStatementSummaryRow(["115/06/21", "行動銀行繳款"]), true);
assert.equal(isFubonStatementSummaryRow(["", "前期應繳總額"]), true);
assert.equal(isFubonStatementSummaryRow(["115/06/21", "咖啡店"]), false);
```

Add `isEsunCompleteGrid({ currentPage: "1", currentPageSize: String(2_147_483_647) })` tests and Yuanta HTML fixtures where `hasUntraversedPager(html)` rejects a pager and accepts the observed no-pager response.

- [ ] **Step 2: Run the workflow checks.**

Run: `node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts && node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts && node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts`

Expected: FAIL for missing completeness/summary helpers.

- [ ] **Step 3: Implement bank-specific validation plus shared metadata.**

```ts
const capture = {
  snapshotMode: "full" as const, captureId: randomUUID(),
  capturedAt: new Date().toISOString(), captureKinds: ["billed", "unbilled"] as const,
  completenessEvidence,
};
const allCardKeys = unique([...billedRows, ...unbilledRows].map(cardKeyForRow));
await writeStatementFile(nextTimestamp, "billed", billedRows, capture, allCardKeys);
await writeStatementFile(nextTimestamp, "unbilled", unbilledRows, capture, allCardKeys);
```

- Esun: use only its default one-year range; after query require live grid page 1/size `2_147_483_647` before splitting the combined result by status. Explicit date inputs are partial.
- Fubon: full requires all six observed periods, no card filters, unbilled detail, and all observed grids at page 1/size `2_147_483_647`. Apply `isFubonStatementSummaryRow()` before `isDateLike`; map `網路繳款` to optional `paid_by_online_banking` metadata, never a CSV detail row.
- Yuanta: full requires all exposed month options, unbilled enabled, no month override, and no pager in every response. Keep the existing form-response approach and add only the pure pager guard.

For incomplete/scoped output, write CSV evidence with `snapshotMode: "partial"` and a completeness reason, omitting full-only fields.

- [ ] **Step 4: Verify static checks and each live workflow.**

Run:

```bash
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts
npx libretto status
npx libretto run src/workflows/esun-credit-card-statements.ts --session esun-capture-validate --stay-open-on-success
npx libretto run src/workflows/fubon-credit-card-statements.ts --session fubon-capture-validate --stay-open-on-success
npx libretto run src/workflows/yuanta-credit-card-statements.ts --session yuanta-capture-validate --stay-open-on-success
```

Expected: static checks PASS; each successful run emits two sidecars with identical id/time/kinds/card-key set. Pause for user CAPTCHA entry; inspect sidecars then close each disposable session.

- [ ] **Step 5: Commit workflow changes.**

```bash
git add src/workflows/esun-credit-card-statements.ts src/workflows/esun-credit-card-statements.check.ts src/workflows/fubon-credit-card-statements.ts src/workflows/fubon-credit-card-statements.check.ts src/workflows/yuanta-credit-card-statements.ts src/workflows/yuanta-credit-card-statements.check.ts
git commit -m "feat: emit verified credit card captures"
```

### Task 5: Read only verified latest capture state

**Files:**
- Modify: `src/lib/shared-ledger/server/accounts.ts`
- Modify: `src/lib/shared-ledger/server/accounts.check.ts`
- Modify: `src/lib/overview/server/load-overview.ts`
- Modify: `src/lib/liabilities/server/load-liabilities.ts`
- Modify: `src/lib/assets/server/load-assets.ts`
- Modify: `src/lib/shared-ledger/server/mock-data.ts`

**Interfaces:**
- Extends `LedgerQueryData` with `creditCardCaptures` and `creditCardCaptureEntries`.
- Produces `latestVerifiedCreditCardRows(data)` and `latestVerifiedCreditCardSnapshots(data)`.

- [ ] **Step 1: Write failing reader fixtures.**

```ts
data.creditCardStatementLines = [legacyUnbilled, oldCaptureUnbilled, latestCaptureBilled];
data.creditCardCaptures = [oldCapture, latestCapture];
data.creditCardCaptureEntries = [oldEntry, latestEntry];
data.creditCardSnapshots = [oldUnbilledSnapshot, latestBilledSnapshot, latestZeroUnbilledSnapshot];
assert.deepEqual(buildTransactionsByAccount(data)[cardId].map((row) => row.type), ["billed"]);
assert.equal(buildAccountOverview(data).find((row) => row.id === cardId)?.amountLines[0]?.value, 0);
```

Add a latest capture with two identical occurrences (both must display) and a legacy-only fixture (no card account/transaction).

- [ ] **Step 2: Run the accounts check.**

Run: `node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts`

Expected: FAIL because current code maps every statement row and chooses snapshots without verified capture ids.

- [ ] **Step 3: Add one selection path and load its tables everywhere.**

```ts
function latestVerifiedCreditCardRows(data: LedgerQueryData) {
  const captures = new Map(data.creditCardCaptures.map((capture) => [capture.captureId, capture]));
  const latestCaptureByCard = new Map<string, string>();
  for (const entry of data.creditCardCaptureEntries) {
    const capture = captures.get(entry.captureId);
    if (!capture) continue;
    const card = [entry.bank, entry.product, entry.cardKey].join("|");
    const previousId = latestCaptureByCard.get(card);
    const previous = previousId ? captures.get(previousId) : undefined;
    if (!previous || [capture.capturedAt, capture.captureId].join("|") > [previous.capturedAt, previous.captureId].join("|")) {
      latestCaptureByCard.set(card, capture.captureId);
    }
  }
  const rowIds = new Set(data.creditCardCaptureEntries
    .filter((entry) => latestCaptureByCard.get([entry.bank, entry.product, entry.cardKey].join("|")) === entry.captureId)
    .map((entry) => entry.statementRowId));
  return data.creditCardStatementLines.filter((row) => rowIds.has(row.statementRowId));
}
```

Use the same per-card selected capture ids for snapshots with non-null `captureId`; `buildTransactionsByAccount` maps only selected rows and `creditCardPositions` uses only latest selected unbilled aggregates. Load both new tables in overview/liabilities/assets and add empty arrays to `emptyLedgerQueryData()`/mock data.

- [ ] **Step 4: Verify and commit.**

Run: `node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts && npm run typecheck`

Expected: PASS; current UI has one current status per transaction and balance is latest unbilled only.

```bash
git add src/lib/shared-ledger/server/accounts.ts src/lib/shared-ledger/server/accounts.check.ts src/lib/overview/server/load-overview.ts src/lib/liabilities/server/load-liabilities.ts src/lib/assets/server/load-assets.ts src/lib/shared-ledger/server/mock-data.ts
git commit -m "feat: read credit cards from verified captures"
```

### Task 6: Keep every verified capture timestamp in account history

**Files:**
- Modify: `src/lib/shared-ledger/types.ts`
- Modify: `src/lib/overview/server/daily-history.ts`
- Modify: `src/lib/overview/server/daily-history.check.ts`
- Modify: `src/lib/overview/components/snapshot-chart-data.{ts,check.ts}`
- Modify: `src/lib/shared-accounts/components/stacked-balance-chart-data.{ts,check.ts}`
- Modify: `src/lib/shared-accounts/components/AccountHistoryModal.svelte`
- Modify: `src/lib/overview/components/DailyHistoryTable.svelte`

**Interfaces:**
- Adds `pointAt?: string` to `DailyHistoryRowDto`; `date` remains a calendar date.

- [ ] **Step 1: Write failing same-day capture assertions.**

```ts
const history = buildDailyHistoryByAccount(cardData)[cardId] ?? [];
assert.deepEqual(history.map((row) => [row.date, row.pointAt, row.liabilities[0]?.value]), [
  ["2026-07-12", "2026-07-12T08:00:00.000Z", 120],
  ["2026-07-12", "2026-07-12T10:00:00.000Z", 180],
]);
```

Add chart assertions that both `pointAt` values create distinct increasing points, while ordinary source-file history remains date-only.

- [ ] **Step 2: Run the history/chart checks.**

Run: `node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts && node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts && node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts`

Expected: FAIL because the current implementation keys all points by `date`.

- [ ] **Step 3: Use one history key in all readers and charts.**

```ts
export type DailyHistoryRowDto = { date: string; pointAt?: string; netAssets: CurrencyAmountDto[];
  dailyChange: CurrencyAmountDto[]; assets: CurrencyAmountDto[]; liabilities: CurrencyAmountDto[];
  accountChanges: string[]; positionCount: number; };

function historyPointKey(row: DailyHistoryRowDto) { return row.pointAt ?? row.date; }
```

`daily-history.ts` adds every verified `capturedAt` and filters capture data with `captured_at <= pointAt`. Chart collection/lookup/sort, account-modal sort, and table sort use the key. The table and tooltip render `YYYY-MM-DD HH:mm` when `pointAt` exists and retain date-only rendering otherwise.

- [ ] **Step 4: Verify and commit.**

Run: `node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts && node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts && node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts && npm run typecheck`

Expected: PASS; two verified captures on a date produce two table/chart points.

```bash
git add src/lib/shared-ledger/types.ts src/lib/overview/server/daily-history.ts src/lib/overview/server/daily-history.check.ts src/lib/overview/components/snapshot-chart-data.ts src/lib/overview/components/snapshot-chart-data.check.ts src/lib/shared-accounts/components/stacked-balance-chart-data.ts src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts src/lib/shared-accounts/components/AccountHistoryModal.svelte src/lib/overview/components/DailyHistoryTable.svelte
git commit -m "feat: show every verified card capture point"
```

### Task 7: Verify and roll out safely

**Files:**
- Modify only the owning task file if a deterministic check exposes a defect.
- Do not modify: `~/Library/Application Support/OctopusBeak/temp/**`.

- [ ] **Step 1: Run the deterministic suite.**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/credit-card-capture.check.ts
node --no-warnings --experimental-strip-types src/ledger/credit-card-identity.check.ts
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/workflows/esun-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/fubon-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/workflows/yuanta-credit-card-statements.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts
node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts
node --no-warnings --experimental-strip-types src/lib/overview/components/snapshot-chart-data.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-accounts/components/stacked-balance-chart-data.check.ts
npm run typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Capture and import real data with CAPTCHA handoff.**

Run each Task-4 workflow headed in a disposable Libretto session. On CAPTCHA, wait for user completion and resume that session. Inspect the two sidecars for shared id/time/kinds/card counts, then import each bank with its exact filter:

```bash
npm run run:import-downloads-csv -- --params '{"bankFilters":["esun"],"productFilters":["credit-card-statements"]}'
npm run run:import-downloads-csv -- --params '{"bankFilters":["fubon"],"productFilters":["credit-card-statements"]}'
npm run run:import-downloads-csv -- --params '{"bankFilters":["yuanta"],"productFilters":["credit-card-statements"]}'
```

Expected: no semantic-key unique error and one verified capture plus entries/snapshots per complete pair. Close every disposable session after inspection.

- [ ] **Step 3: Verify Electron UI.**

Confirm in Liabilities: latest-capture transactions only; current card balance equals latest unbilled aggregate; Fubon excludes the three summary descriptions; same-day verified captures have separate points; legacy partial balances are absent. Never restore from `temp` during this test. If recovery becomes necessary, first copy the active ledger to a new timestamped backup and request separate user confirmation.

- [ ] **Step 4: Finish cleanly.**

Run: `git status --short && git diff --check`

Expected: no uncommitted implementation changes. Any defect must first receive a failing check in its owning task, then a minimal repair and repeat of this suite.
