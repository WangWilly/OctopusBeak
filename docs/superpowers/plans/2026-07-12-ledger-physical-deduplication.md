# Ledger Physical Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain only the deterministic earliest copy of identical imported statement content, preserve displayed account values, and remove obsolete duplicate-only APIs and columns.

**Architecture:** SQLite migration 12 cleans legacy ordinary statement tables and adds one unique `content_hash` index per table. The importer reports ignored conflicts as aggregate run metadata. Migration 13 then drops the two obsolete common columns from ordinary and personal-invoice statement tables while consumer code stops filtering rows that can no longer exist.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, SQLite migrations, assert-based `.check.ts` scripts, SvelteKit/Electron build.

## Global Constraints

- Duplicate identity is equal `content_hash` within one ordinary typed statement table.
- Retain the earliest row by `imported_at`, `source_relative_path`, `source_row_index`, then `statement_row_id`, all ascending.
- SQLite, not an in-memory set, owns the uniqueness invariant.
- Personal invoices keep `invoice_key`/`item_key` upserts and do not receive a `content_hash` unique index.
- Only an expected `content_hash` uniqueness conflict may be counted as a skipped duplicate; all other database errors remain fatal.
- Add no dependency, UI, duplicate-history table, or compatibility abstraction.

---

### Task 1: Physically Deduplicate Legacy Ordinary Statement Rows

**Files:**
- Modify: `src/ledger/db/migrations.ts:783-839`
- Modify: `src/ledger/db/migrations.check.ts`

**Interfaces:**
- Consumes: `TYPED_STATEMENT_TABLES: readonly string[]` from `src/ledger/source-csv-parsers.ts`.
- Produces: migration 12 named `physical_content_hash_deduplication`.
- Produces: unique indexes named `uq_<table>_content_hash` on every ordinary typed statement table.

- [ ] **Step 1: Add a failing deterministic-retention migration check**

Add a temporary ledger and insert three `account_transactions` rows sharing one content hash. Use equal timestamps for two rows so all tie-breakers are exercised:

```ts
const dedupeLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-physical-dedupe-"),
);

const dedupeDb = openLedgerDatabase(dedupeLedgerDir);
dedupeDb.exec("DELETE FROM schema_migrations WHERE version >= 12");
for (const table of TYPED_STATEMENT_TABLES) {
  dedupeDb.exec(`DROP INDEX IF EXISTS uq_${table}_content_hash`);
}
const insertAccountRow = dedupeDb.prepare(`
  INSERT INTO account_transactions (
    statement_row_id, source_file_id, import_run_id, source_relative_path,
    source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
    dedupe_status, raw_payload_json, imported_at, created_at, currency
  ) VALUES (?, ?, 'run', ?, ?, ?, ?, 'same-content', 'demo', 'statements',
    ?, '{}', ?, ?, 'TWD')
`);
insertAccountRow.run(
  "later", "later-file", "b.csv", 1, "source-later", "raw-later",
  "duplicate", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z",
);
insertAccountRow.run(
  "tie-later-path", "tie-file", "z.csv", 1, "source-tie", "raw-tie",
  "duplicate", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
);
insertAccountRow.run(
  "canonical", "canonical-file", "a.csv", 1, "source-canonical", "raw-canonical",
  "unique", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
);
migrateLedgerDb(dedupeDb);

const retained = dedupeDb.prepare(`
  SELECT statement_row_id FROM account_transactions
  WHERE content_hash = 'same-content'
`).all().map((row) => ({ ...row }));
const accountIndexes = dedupeDb.prepare(
  "PRAGMA index_list(account_transactions)",
).all() as Array<{ name: string; unique: number }>;

assert.deepEqual(retained, [{ statement_row_id: "canonical" }]);
assert.ok(accountIndexes.some((index) => (
  index.name === "uq_account_transactions_content_hash" && index.unique === 1
)));
assert.throws(() => insertAccountRow.run(
  "blocked", "blocked-file", "c.csv", 1, "source-blocked", "raw-blocked",
  "duplicate", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z",
), /UNIQUE constraint failed: account_transactions.content_hash/);
dedupeDb.close();
```

Include `dedupeLedgerDir` in the existing `finally` cleanup array. Update the fresh database migration expectation from versions `1..11` to `1..12`.

- [ ] **Step 2: Run the migration check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: FAIL because migration 12 and `uq_account_transactions_content_hash` do not exist.

- [ ] **Step 3: Add migration 12**

Add this function above the migration array:

```ts
function physicallyDeduplicateStatementRows(db: LedgerDatabase) {
  for (const table of TYPED_STATEMENT_TABLES) {
    db.exec(`
      DELETE FROM ${table}
      WHERE statement_row_id IN (
        SELECT statement_row_id
        FROM (
          SELECT
            statement_row_id,
            ROW_NUMBER() OVER (
              PARTITION BY content_hash
              ORDER BY imported_at ASC, source_relative_path ASC,
                source_row_index ASC, statement_row_id ASC
            ) AS duplicate_rank
          FROM ${table}
        )
        WHERE duplicate_rank > 1
      );
      CREATE UNIQUE INDEX uq_${table}_content_hash
        ON ${table}(content_hash);
    `);
  }
}
```

Append migration 12:

```ts
{
  version: 12,
  name: "physical_content_hash_deduplication",
  up: physicallyDeduplicateStatementRows,
},
```

Do not add these indexes to personal invoice tables.

- [ ] **Step 4: Run the migration check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: exit 0; only `canonical` remains and the unique index rejects another equal content hash.

- [ ] **Step 5: Commit legacy physical deduplication**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts
git commit -m "feat: physically deduplicate ledger rows"
```

---

### Task 2: Skip New Duplicate Rows and Record Aggregate Counts

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts:258-271,406-548,652-868`
- Modify: `src/ledger/import-downloads-csv.check.ts`

**Interfaces:**
- Consumes: migration 12's `UNIQUE(content_hash)` indexes.
- Produces: `insertTypedStatementRow(...): "inserted" | "duplicate" | "upserted"`.
- Produces: `skippedDuplicateRows: number` in completed import run, completed event, and returned result.

- [ ] **Step 1: Add a failing ordinary-statement duplicate import check**

Add a second temporary scenario to `import-downloads-csv.check.ts`. Create
`ctbc-statements/first.csv` with one row using these headers and values:

```ts
const accountHeaders = [
  "帳務日期", "交易日期", "交易時間", "摘要",
  "支出金額", "存入金額", "即時餘額", "附註",
];
const accountRow = {
  帳務日期: "2026/07/03",
  交易日期: "2026/07/02",
  交易時間: "09:08:07",
  摘要: "薪資",
  支出金額: "0",
  存入金額: "1234",
  即時餘額: "5678",
  附註: "公司入帳",
};
const ordinaryInput = {
  downloadsDir: ordinaryDownloadsDir,
  outputDir: ordinaryOutputDir,
  bankFilters: ["ctbc"],
  productFilters: ["statements"],
};
```

Run the first import, then add `ctbc-statements/second.csv` containing
`accountRow` twice and run the same input again. The different source path
avoids the intentional file-path skip, while the parsed content remains
identical. Capture both results and query `account_transactions`; parse the
latest `import_runs.record_json` and completed `import_run_events.record_json`:

```ts
const firstResult = await importDownloadsCsv(ordinaryInput);
const secondResult = await importDownloadsCsv(ordinaryInput);

assert.equal(firstResult.importedRows, 1);
assert.equal(firstResult.skippedDuplicateRows, 0);
assert.equal(secondResult.importedRows, 0);
assert.equal(secondResult.skippedDuplicateRows, 2);
assert.equal(accountRowCount.count, 1);
assert.equal(secondRun.skippedDuplicateRows, 2);
assert.equal(secondCompletedEvent.skippedDuplicateRows, 2);
```

Expect `skippedDuplicateRows === 2` for the second run with the stored row
count still `1`.

- [ ] **Step 2: Run the import check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: FAIL because `skippedDuplicateRows` is missing and current `importedRows` counts parsed rather than inserted rows.

- [ ] **Step 3: Make ordinary inserts report only the expected uniqueness conflict**

Replace generic `INSERT OR IGNORE` with a plain insert returning SQLite changes:

```ts
export function insertRecord(
  db: LedgerDatabase,
  table: string,
  record: Record<string, unknown>,
): "inserted" | "duplicate" {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  try {
    db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    ).run(...columns.map((column) => sqliteValue(record[column])));
    return "inserted";
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes(`UNIQUE constraint failed: ${table}.content_hash`)
    ) return "duplicate";
    throw error;
  }
}
```

Return `"upserted"` from the personal invoice branch and return `insertRecord(...)` from the ordinary branch of `insertTypedStatementRow`. Do not catch check, foreign-key, primary-key, or unrelated unique errors.

- [ ] **Step 4: Count durable outcomes inside the transaction**

Stop incrementing `importedRows` while parsing. Initialize both counters before the transaction:

```ts
let importedRows = 0;
let skippedDuplicateRows = 0;
```

Count the result where rows are written:

```ts
for (const item of statementRows) {
  const outcome = insertTypedStatementRow(db, item.sourceFileRecord, item.row);
  if (outcome === "duplicate") skippedDuplicateRows += 1;
  else importedRows += 1;
}
```

Build `runRecord`, `completedEvent`, and the returned `result` after these counters are final, and include `skippedDuplicateRows` in all three objects. Remove `importedContentHashes()` and the parse-time `dedupeStatus` calculation; every parsed ordinary row reaches the database constraint. Personal-invoice upserts count as imported rows.

- [ ] **Step 5: Add a fatal-error regression assertion**

Export `insertRecord` directly for its focused check; do not wrap it in a new
test abstraction. In the check, open a migrated temporary database and pass a
complete common row that omits the required `currency` table column:

```ts
assert.throws(() => insertRecord(failureDb, "account_transactions", {
  statement_row_id: "invalid-row",
  source_file_id: "invalid-file",
  import_run_id: "invalid-run",
  source_relative_path: "ctbc-statements/invalid.csv",
  source_row_index: 1,
  source_hash: "invalid-source",
  raw_row_hash: "invalid-raw",
  content_hash: "invalid-content",
  bank: "ctbc",
  product: "statements",
  dedupe_status: "unique",
  raw_payload_json: "{}",
  imported_at: "2026-07-12T00:00:00.000Z",
}), /NOT NULL constraint failed: account_transactions.currency/);
const rowsAfterFailedInsert = failureDb.prepare(`
  SELECT COUNT(*) AS count FROM account_transactions
`).get() as { count: number };
assert.equal(rowsAfterFailedInsert.count, 0);
```

This proves the catch handles only the named content-hash conflict.

- [ ] **Step 6: Run importer and automation regression checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
```

Expected: both exit 0; duplicates are counted without storage and unrelated failures still roll back.

- [ ] **Step 7: Commit import-time duplicate skipping**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "feat: skip duplicate ledger imports"
```

---

### Task 3: Remove Duplicate-Only Consumers and Common Columns

**Files:**
- Modify: `src/ledger/db/migrations.ts:783-839`
- Modify: `src/ledger/db/migrations.check.ts`
- Modify: `src/ledger/db/schema.ts:3-18`
- Modify: `src/ledger/import-downloads-csv.ts:273-314,406-530`
- Modify: `src/ledger/financial-dashboard-types.ts:20-59,196-212`
- Modify: `src/ledger/financial-dashboard-repo.ts:71-108`
- Modify: `src/ledger/financial-dashboard-model.ts:2115-2219`
- Modify: `src/lib/shared-ledger/server/accounts.ts:45-51,231-402,994-996`
- Modify: `src/ledger/seed-mock-ledger-db.ts`
- Modify: `src/lib/shared-ledger/server/mock-data.ts`
- Modify: `src/lib/shared-ledger/server/accounts.check.ts`
- Modify: `src/lib/overview/server/daily-history.check.ts`
- Modify: `src/ledger/import-downloads-csv.check.ts`
- Modify: `src/lib/spending/server/store.check.ts`

**Interfaces:**
- Consumes: migration 12's invariant that ordinary stored rows are unique.
- Produces: migration 13 named `retired_duplicate_occurrence_columns`.
- Produces: common statement schemas without `raw_row_hash` or `dedupe_status`.
- Preserves: `source_hash`, `content_hash`, raw payload, personal-invoice keys, category, indexes, and foreign keys.

- [ ] **Step 1: Add failing migration-13 schema assertions**

Update expected migration versions to `1..13`. For every ordinary table plus both personal-invoice tables, assert the retired columns are absent and retained columns remain:

```ts
const commonStatementTables = [
  ...TYPED_STATEMENT_TABLES,
  "personal_invoices",
  "personal_invoice_items",
] as const;

for (const table of commonStatementTables) {
  const columns = migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  assert.equal(names.has("dedupe_status"), false, table);
  assert.equal(names.has("raw_row_hash"), false, table);
  assert.equal(names.has("content_hash"), true, table);
  assert.equal(names.has("source_hash"), true, table);
  assert.equal(names.has("raw_payload_json"), true, table);
}
```

Retain the existing personal-invoice index, foreign-key, integer-sequence, and category assertions.

- [ ] **Step 2: Run the migration check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: FAIL because migration 13 does not exist and both columns remain.

- [ ] **Step 3: Add migration 13 and update the current Drizzle schema**

Remove both column declarations from `commonColumns()` in `db/schema.ts`.
Keep them in migration 1's `COMMON_ROW_COLUMNS`: fresh databases must replay
the historical schema through migration 4 before migration 13 removes the
columns. Add:

```ts
const COMMON_STATEMENT_TABLES = [
  ...TYPED_STATEMENT_TABLES,
  "personal_invoices",
  "personal_invoice_items",
] as const;

function retireDuplicateOccurrenceColumns(db: LedgerDatabase) {
  for (const table of COMMON_STATEMENT_TABLES) {
    db.exec(`
      ALTER TABLE ${table} DROP COLUMN dedupe_status;
      ALTER TABLE ${table} DROP COLUMN raw_row_hash;
    `);
  }
}
```

Append:

```ts
{
  version: 13,
  name: "retired_duplicate_occurrence_columns",
  up: retireDuplicateOccurrenceColumns,
},
```

`migrateLedgerDb` already wraps each migration in a transaction; add no nested transaction.

- [ ] **Step 4: Remove writes and model fields for retired columns**

Keep `rawRowHash` as transient importer data, including the importer helper
parameter types, because `statement_row_id` and `source_hash` still use it.
Remove only the `raw_row_hash` property from the returned database record.
Remove `dedupe_status` from common fields and both personal-invoice
update-column arrays.

Remove `rawRowHash` and `dedupeStatus` from `TypedStatementRow`, `RawTransactionOccurrence`, account `CommonRow`, mock data, seed data, and checks. Update direct SQL inserts in spending checks to omit the two columns and values.
Also remove `raw_row_hash` and `dedupe_status` from Task 2's direct
`insertRecord` failure fixture so it matches the post-migration schema.

- [ ] **Step 5: Remove obsolete filtering and dashboard API**

In the account position functions, replace patterns such as:

```ts
records.accountTransactions.filter(isUnique)
```

with:

```ts
records.accountTransactions
```

Delete `isUnique`. Remove `includeDuplicates` from `BuildFinancialDashboardInput`. Build the model directly from all `typedRows`:

```ts
const rows = typedRows;
const sourceRows = new Map(rows.map((row) => [row.sourceHash, row]));
const classifications = classifyDashboardData(ledgerRecords, () => true);
```

Remove `rawRows`, `uniqueRows`, and `duplicateRows` from `FinancialModel["counts"]` and `baseModel.counts`. Keep `duplicateNormalizedTransactions`; it represents semantic transaction merging, not exact content duplication.

- [ ] **Step 6: Run focused checks and TypeScript verification**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts
node --no-warnings --experimental-strip-types src/lib/overview/server/daily-history.check.ts
node --no-warnings --experimental-strip-types src/lib/spending/server/store.check.ts
npm run typecheck
```

Expected: every command exits 0; account expectations are unchanged after removing duplicate fixtures and filters.

- [ ] **Step 7: Commit consumer and column retirement**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts \
  src/ledger/db/schema.ts src/ledger/import-downloads-csv.ts \
  src/ledger/import-downloads-csv.check.ts \
  src/ledger/financial-dashboard-types.ts \
  src/ledger/financial-dashboard-repo.ts \
  src/ledger/financial-dashboard-model.ts \
  src/ledger/seed-mock-ledger-db.ts \
  src/lib/shared-ledger/server/accounts.ts \
  src/lib/shared-ledger/server/accounts.check.ts \
  src/lib/shared-ledger/server/mock-data.ts \
  src/lib/overview/server/daily-history.check.ts \
  src/lib/spending/server/store.check.ts
git commit -m "refactor: retire ledger duplicate fields"
```

---

### Task 4: Full Build and Electron Behavior Verification

**Files:**
- No product files expected.
- Modify only earlier task files if verification exposes a regression.

**Interfaces:**
- Consumes: completed migrations 12-13, importer outcomes, and consumer cleanup.
- Produces: verified production bundles and live Electron account overview behavior.

- [ ] **Step 1: Run the complete relevant static verification**

Run:

```bash
git diff --check
npm run typecheck
npm run build
```

Expected: no whitespace errors, typecheck exits 0, renderer and Electron bundles build successfully.

- [ ] **Step 2: Start the mock Electron app**

Run and keep the process alive:

```bash
npm run desktop:dev:mock
```

Expected: Electron logs a DevTools/CDP endpoint, normally on `127.0.0.1:9222`.

- [ ] **Step 3: Verify the account overview through CDP**

Connect to the printed endpoint, open the account overview, and confirm:

- account, cash, liability, fund, and brokerage sections render;
- no renderer or main-process error mentions missing `dedupe_status` or `raw_row_hash`;
- displayed totals match the focused `accounts.check.ts` expectations generated from the same mock ledger;
- reloading the view does not change totals.

Use the Electron debugging skill workflow and preserve the running app until inspection is complete.

- [ ] **Step 4: Stop the development process and review scope**

Stop only the process started in Step 2. Run:

```bash
git status --short
git log -4 --oneline
```

Expected: only planned files changed and the three implementation commits are present.
