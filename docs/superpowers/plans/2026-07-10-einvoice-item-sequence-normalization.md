# E-Invoice Item Sequence Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store e-invoice item sequence numbers as canonical SQLite integers and make padded values share one stable item identity.

**Architecture:** Normalize and validate sequence values once in the typed CSV parser, then use that result for both `item_key` and the stored field. Migration 10 rebuilds existing `personal_invoice_items` tables with integer affinity, canonicalizes keys, and deterministically retains the newest row when padded legacy keys collapse.

**Tech Stack:** TypeScript, Node.js `assert`, SQLite `DatabaseSync`, SQL window functions

## Global Constraints

- `personal_invoice_items.item_sequence_number` must be a nullable, non-negative SQLite `INTEGER`.
- `"0"` remains `0`; `"1"`, `"01"`, and `"001"` all become integer `1`.
- Numeric item keys must end with the canonical integer sequence.
- Empty sequences remain `NULL` and keep the existing content-based fallback key.
- Nonnumeric, negative, and unsafe integer values must fail without partial writes or purchase-data disclosure.
- Migration 10 must preserve provenance and raw payloads and retain the newest row when canonical keys collide.
- The workflow and generated CSV retain the provider's raw sequence string.
- Do not add dependencies or change automation, CAPTCHA, Assist, invoice identity, or unrelated import behavior.

---

### Task 1: Canonicalize Sequence Values In The Typed Parser

**Files:**
- Modify: `src/ledger/source-csv-parsers.check.ts:132-197`
- Modify: `src/ledger/source-csv-parsers.ts:149-221`

**Interfaces:**
- Consumes: `cleanTypedCell(value: unknown): string` and `rawPayload.item_sequence_number`.
- Produces: internal `personalInvoiceItemSequenceNumber(value: unknown): number | null`.
- Produces: `personalInvoiceItemKey(rawPayload)` with a canonical numeric suffix.
- Produces: `personalInvoiceItemFields(rawPayload).item_sequence_number` as `number | null`.

- [ ] **Step 1: Write failing parser and key assertions**

Change `einvoicePayload.item_sequence_number` in `src/ledger/source-csv-parsers.check.ts` to `"001"`. Update the existing e-invoice expectations and append the boundary assertions below:

```ts
assert.equal(
  personalInvoiceItemKey(einvoicePayload),
  "AB12345678|1783065600|24536806|1",
);

assert.deepEqual(personalInvoiceItemFields(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: 1,
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});

assert.deepEqual(einvoiceParser.parseRow(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: 1,
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});

const zeroSequencePayload = {
  ...einvoicePayload,
  item_sequence_number: "0",
};
assert.equal(
  personalInvoiceItemKey(zeroSequencePayload),
  "AB12345678|1783065600|24536806|0",
);
assert.equal(
  personalInvoiceItemFields(zeroSequencePayload).item_sequence_number,
  0,
);

for (const invalidSequence of ["-1", "1.5", "item-1"]) {
  assert.throws(
    () => personalInvoiceItemFields({
      ...einvoicePayload,
      item_sequence_number: invalidSequence,
    }),
    /expected a non-negative decimal integer/,
  );
}

assert.throws(
  () => personalInvoiceItemFields({
    ...einvoicePayload,
    item_sequence_number: "9007199254740992",
  }),
  /exceeds the safe integer range/,
);
```

Keep the existing invoice-field assertions unchanged.

- [ ] **Step 2: Run the parser check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Expected: FAIL because the key ends in `|001` and the stored sequence is the string `"001"`.

- [ ] **Step 3: Add the strict sequence parser and use it for identity and storage**

Add this internal helper after `cleanTypedCell` in `src/ledger/source-csv-parsers.ts`:

```ts
function personalInvoiceItemSequenceNumber(value: unknown): number | null {
  const raw = cleanTypedCell(value);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "Invalid personal invoice item_sequence_number: expected a non-negative decimal integer",
    );
  }
  const sequenceNumber = Number(raw);
  if (!Number.isSafeInteger(sequenceNumber)) {
    throw new Error(
      "Invalid personal invoice item_sequence_number: exceeds the safe integer range",
    );
  }
  return sequenceNumber;
}
```

Replace the sequence handling in `personalInvoiceItemKey`:

```ts
export function personalInvoiceItemKey(rawPayload: Record<string, string>): string {
  const invoiceKey = personalInvoiceKey(rawPayload);
  const sequenceNumber = personalInvoiceItemSequenceNumber(
    rawPayload.item_sequence_number,
  );
  if (sequenceNumber !== null) return `${invoiceKey}|${sequenceNumber}`;
  return [
    invoiceKey,
    cleanTypedCell(rawPayload.item_product_name),
    cleanTypedCell(rawPayload.item_quantity),
    cleanTypedCell(rawPayload.item_unit_price),
    cleanTypedCell(rawPayload.item_paid_amount),
  ].join("|");
}
```

Replace the sequence field in `personalInvoiceItemFields`:

```ts
item_sequence_number: personalInvoiceItemSequenceNumber(
  rawPayload.item_sequence_number,
),
```

- [ ] **Step 4: Rerun the parser check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
```

Expected: exit code 0 with no assertion output.

- [ ] **Step 5: Verify TypeScript compilation**

Run:

```bash
npx tsc --noEmit
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 6: Commit parser normalization**

```bash
git add src/ledger/source-csv-parsers.ts src/ledger/source-csv-parsers.check.ts
git commit -m "fix: normalize e-invoice item sequence keys"
```

---

### Task 2: Migrate Sequence Storage To SQLite INTEGER

**Files:**
- Modify: `src/ledger/import-downloads-csv.check.ts:32-190`
- Modify: `src/ledger/db/migrations.check.ts:1-39`
- Modify: `src/ledger/db/migrations.ts:336-381,645-691`

**Interfaces:**
- Consumes: Task 1's `personalInvoiceItemFields(rawPayload).item_sequence_number: number | null` and canonical `personalInvoiceItemKey(rawPayload)`.
- Produces: migration 10 named `normalized_personal_invoice_item_sequence_numbers`.
- Produces: `personal_invoice_items.item_sequence_number INTEGER CHECK (...)` for new and migrated databases.
- Preserves: every retained common row field, raw payload, invoice foreign key, and named item index.

- [ ] **Step 1: Write a failing new-database import assertion**

In `src/ledger/import-downloads-csv.check.ts`, change `confirmedRow.item_sequence_number` to `"001"`. Extend the item query and type:

```ts
const item = db.prepare(
  [
    "SELECT statement_row_id, item_sequence_number,",
    "typeof(item_sequence_number) AS item_sequence_type,",
    "item_product_name, item_paid_amount, source_relative_path, raw_payload_json",
    "FROM personal_invoice_items",
  ].join(" "),
).get() as {
  statement_row_id: string;
  item_sequence_number: number;
  item_sequence_type: string;
  item_product_name: string;
  item_paid_amount: number;
  source_relative_path: string;
  raw_payload_json: string;
};
```

Update the expected item fields while keeping `raw_payload_json` based on the padded `confirmedRow`:

```ts
item_sequence_number: 1,
item_sequence_type: "integer",
```

- [ ] **Step 2: Run the import check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: FAIL because the current `TEXT` column stores the canonical value with SQLite type `text`.

- [ ] **Step 3: Change the new-database item schema to INTEGER**

Replace the sequence column in `createPersonalInvoiceStatementTables`:

```sql
item_sequence_number INTEGER
  CHECK (
    item_sequence_number IS NULL
    OR (
      typeof(item_sequence_number) = 'integer'
      AND item_sequence_number >= 0
    )
  ),
```

- [ ] **Step 4: Rerun the import check and verify GREEN for new databases**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
```

Expected: exit code 0. The stored value is integer `1`, its SQLite type is `integer`, repeated import keeps one item, and `raw_payload_json` still contains `"item_sequence_number":"001"`.

- [ ] **Step 5: Write failing migration-10 checks**

In `src/ledger/db/migrations.check.ts`:

1. Import `migrateLedgerDb` and `type LedgerDatabase`:

```ts
import { openLedgerDatabase, type LedgerDatabase } from "./client.ts";
import { migrateLedgerDb } from "./migrations.ts";
```

2. Create all three temporary directories before the `try` block so the
   existing `finally` block can always remove them:

```ts
const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-db-migrations-"));
const legacyLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-sequence-migration-"),
);
const invalidLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-invalid-sequence-"),
);
```

3. Add these helpers above the test body:

```ts
const invoiceKey = "AB12345678|1783065600|24536806";

function resetItemsToVersion9(db: LedgerDatabase) {
  db.exec(`
    DROP TABLE personal_invoice_items;
    CREATE TABLE personal_invoice_items (
      statement_row_id TEXT PRIMARY KEY,
      source_file_id TEXT NOT NULL,
      import_run_id TEXT NOT NULL,
      source_relative_path TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      raw_row_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bank TEXT NOT NULL,
      product TEXT NOT NULL,
      dedupe_status TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      item_key TEXT NOT NULL UNIQUE,
      invoice_key TEXT NOT NULL,
      item_sequence_number TEXT,
      item_quantity REAL,
      item_unit_price REAL,
      item_paid_amount REAL,
      item_product_name TEXT,
      FOREIGN KEY (invoice_key) REFERENCES personal_invoices(invoice_key)
    );
    CREATE INDEX idx_personal_invoice_items_invoice_key
      ON personal_invoice_items(invoice_key);
    CREATE INDEX idx_personal_invoice_items_product_name
      ON personal_invoice_items(item_product_name);
    DELETE FROM schema_migrations WHERE version = 10;
    INSERT OR IGNORE INTO personal_invoices (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at, invoice_key,
      invoice_id, rebated
    ) VALUES (
      'invoice-row', 'invoice-source', 'invoice-run', 'legacy.csv',
      1, 'invoice-source-hash', 'invoice-raw-hash', 'invoice-content-hash',
      'einvoice', 'personal-invoices', 'unique', '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '${invoiceKey}', 'AB12345678', 0
    );
  `);
}

function insertLegacyItem(
  db: LedgerDatabase,
  input: {
    id: string;
    sourceRowIndex: number;
    sequence: string;
    importedAt: string;
    productName: string;
  },
) {
  db.prepare(`
    INSERT INTO personal_invoice_items (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at, item_key,
      invoice_key, item_sequence_number, item_quantity, item_unit_price,
      item_paid_amount, item_product_name
    ) VALUES (?, ?, ?, 'legacy.csv', ?, ?, ?, ?, 'einvoice',
      'personal-invoices', 'unique', ?, ?, ?, ?, ?, ?, 1, 10, 10, ?)
  `).run(
    input.id,
    `source-${input.id}`,
    `run-${input.id}`,
    input.sourceRowIndex,
    `source-hash-${input.id}`,
    `raw-hash-${input.id}`,
    `content-hash-${input.id}`,
    JSON.stringify({ item_sequence_number: input.sequence }),
    input.importedAt,
    input.importedAt,
    `${invoiceKey}|${input.sequence}`,
    invoiceKey,
    input.sequence,
    input.productName,
  );
}
```

4. Update the existing fresh/partial-upgrade expectations:

```ts
assert.deepEqual(
  versions.map((row) => row.version),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
);
const sequenceColumn = itemColumns.find(
  (column) => column.name === "item_sequence_number",
);
assert.equal(sequenceColumn?.type, "INTEGER");
```

Change the `itemColumns` row type to include `type: string`.

5. Add a legacy collision migration case using the second temporary ledger:

```ts
const legacyDb = openLedgerDatabase(legacyLedgerDir);
resetItemsToVersion9(legacyDb);
insertLegacyItem(legacyDb, {
  id: "older",
  sourceRowIndex: 1,
  sequence: "1",
  importedAt: "2026-01-01T00:00:00.000Z",
  productName: "Older item",
});
insertLegacyItem(legacyDb, {
  id: "newer",
  sourceRowIndex: 2,
  sequence: "001",
  importedAt: "2026-02-01T00:00:00.000Z",
  productName: "Newest item",
});
migrateLedgerDb(legacyDb);

const migratedItems = legacyDb.prepare(`
  SELECT item_key, item_sequence_number,
    typeof(item_sequence_number) AS sequence_type,
    raw_payload_json, item_product_name
  FROM personal_invoice_items
`).all() as Array<{
  item_key: string;
  item_sequence_number: number;
  sequence_type: string;
  raw_payload_json: string;
  item_product_name: string;
}>;
const itemIndexes = legacyDb.prepare(
  "PRAGMA index_list(personal_invoice_items)",
).all() as Array<{ name: string }>;
const itemForeignKeys = legacyDb.prepare(
  "PRAGMA foreign_key_list(personal_invoice_items)",
).all() as Array<{ table: string; from: string; to: string }>;

assert.deepEqual(migratedItems, [{
  item_key: `${invoiceKey}|1`,
  item_sequence_number: 1,
  sequence_type: "integer",
  raw_payload_json: JSON.stringify({ item_sequence_number: "001" }),
  item_product_name: "Newest item",
}]);
assert.ok(itemIndexes.some(
  (index) => index.name === "idx_personal_invoice_items_invoice_key",
));
assert.ok(itemIndexes.some(
  (index) => index.name === "idx_personal_invoice_items_product_name",
));
assert.ok(itemForeignKeys.some((foreignKey) => (
  foreignKey.table === "personal_invoices"
  && foreignKey.from === "invoice_key"
  && foreignKey.to === "invoice_key"
)));
assert.throws(
  () => legacyDb.prepare(`
    UPDATE personal_invoice_items
    SET item_sequence_number = 'A1'
  `).run(),
  /CHECK constraint failed/,
);
legacyDb.close();
```

6. Add an invalid legacy value rollback case using the third temporary ledger:

```ts
const invalidDb = openLedgerDatabase(invalidLedgerDir);
resetItemsToVersion9(invalidDb);
insertLegacyItem(invalidDb, {
  id: "invalid",
  sourceRowIndex: 1,
  sequence: "A1",
  importedAt: "2026-01-01T00:00:00.000Z",
  productName: "Invalid item",
});

assert.throws(
  () => migrateLedgerDb(invalidDb),
  /1 invalid value/,
);
const invalidColumn = invalidDb.prepare(
  "PRAGMA table_info(personal_invoice_items)",
).all().find((column) => (
  (column as { name: string }).name === "item_sequence_number"
)) as { type: string } | undefined;
const invalidRow = invalidDb.prepare(`
  SELECT item_sequence_number FROM personal_invoice_items
`).get() as { item_sequence_number: string };
const migration10 = invalidDb.prepare(`
  SELECT version FROM schema_migrations WHERE version = 10
`).get();

assert.equal(invalidColumn?.type, "TEXT");
assert.equal(invalidRow.item_sequence_number, "A1");
assert.equal(migration10, undefined);
invalidDb.close();
```

Replace the existing cleanup with:

```ts
} finally {
  for (const directory of [ledgerDir, legacyLedgerDir, invalidLedgerDir]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Run migration checks and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: FAIL because migration version 10 and legacy table normalization do not exist.

- [ ] **Step 7: Implement migration 10**

Add this function after `addPersonalInvoiceStatementTables` in `src/ledger/db/migrations.ts`:

```ts
function normalizePersonalInvoiceItemSequenceNumbers(db: LedgerDatabase) {
  const sequenceColumn = (
    db.prepare("PRAGMA table_info(personal_invoice_items)").all() as Array<{
      name: string;
      type: string;
    }>
  ).find((column) => column.name === "item_sequence_number");
  if (!sequenceColumn) {
    throw new Error(
      "Missing personal_invoice_items.item_sequence_number column",
    );
  }
  if (sequenceColumn.type.toUpperCase() === "INTEGER") return;

  const invalid = db.prepare(`
    SELECT COUNT(*) AS count
    FROM personal_invoice_items
    WHERE item_sequence_number IS NOT NULL
      AND TRIM(item_sequence_number) <> ''
      AND (
        TRIM(item_sequence_number) GLOB '*[^0-9]*'
        OR CAST(TRIM(item_sequence_number) AS INTEGER) > 9007199254740991
      )
  `).get() as { count: number };
  if (invalid.count > 0) {
    throw new Error(
      "Cannot normalize personal_invoice_items.item_sequence_number: "
        + `${invalid.count} invalid value(s)`,
    );
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_personal_invoice_items_invoice_key;
    DROP INDEX IF EXISTS idx_personal_invoice_items_product_name;
    ALTER TABLE personal_invoice_items
      RENAME TO personal_invoice_items_legacy;
  `);
  createPersonalInvoiceStatementTables(db);
  db.exec(`
    WITH normalized AS (
      SELECT
        legacy.*,
        legacy.rowid AS legacy_rowid,
        CASE
          WHEN legacy.item_sequence_number IS NULL
            OR TRIM(legacy.item_sequence_number) = ''
            THEN NULL
          ELSE CAST(TRIM(legacy.item_sequence_number) AS INTEGER)
        END AS normalized_sequence,
        CASE
          WHEN legacy.item_sequence_number IS NULL
            OR TRIM(legacy.item_sequence_number) = ''
            THEN legacy.item_key
          ELSE legacy.invoice_key || '|'
            || CAST(CAST(TRIM(legacy.item_sequence_number) AS INTEGER) AS TEXT)
        END AS normalized_item_key
      FROM personal_invoice_items_legacy AS legacy
    ), ranked AS (
      SELECT
        normalized.*,
        ROW_NUMBER() OVER (
          PARTITION BY normalized_item_key
          ORDER BY imported_at DESC, source_row_index DESC,
            created_at DESC, legacy_rowid DESC
        ) AS canonical_rank
      FROM normalized
    )
    INSERT INTO personal_invoice_items (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at, item_key,
      invoice_key, item_sequence_number, item_quantity, item_unit_price,
      item_paid_amount, item_product_name
    )
    SELECT
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at,
      normalized_item_key, invoice_key, normalized_sequence, item_quantity,
      item_unit_price, item_paid_amount, item_product_name
    FROM ranked
    WHERE canonical_rank = 1;

    DROP TABLE personal_invoice_items_legacy;
  `);
}
```

Append migration 10 to the migrations array:

```ts
{
  version: 10,
  name: "normalized_personal_invoice_item_sequence_numbers",
  up: normalizePersonalInvoiceItemSequenceNumbers,
},
```

- [ ] **Step 8: Rerun migration checks and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/db/migrations.check.ts
```

Expected: exit code 0. Fresh schemas report `INTEGER`, padded collisions retain the newest row under `|1`, indexes and the foreign key exist, and invalid data rolls back to the original `TEXT` table.

- [ ] **Step 9: Run focused regression checks**

Run each command:

```bash
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
node --no-warnings --experimental-strip-types src/ledger/import-downloads-csv.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
npx tsc --noEmit
```

Expected: every command exits 0.

- [ ] **Step 10: Build renderer and Electron bundles**

Run:

```bash
npm run build
```

Expected: renderer and Electron builds complete successfully.

- [ ] **Step 11: Review the final diff**

Run:

```bash
git diff --check
git diff -- src/ledger/source-csv-parsers.ts src/ledger/source-csv-parsers.check.ts src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts src/ledger/import-downloads-csv.check.ts
```

Expected: no whitespace errors and no changes outside parser normalization, integer schema/migration, and their focused checks.

- [ ] **Step 12: Commit schema normalization**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/migrations.check.ts src/ledger/import-downloads-csv.check.ts
git commit -m "fix: store e-invoice item sequences as integers"
```
