import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "./client.ts";
import { migrateLedgerDb } from "./migrations.ts";
import { TYPED_STATEMENT_TABLES } from "../source-csv-parsers.ts";

const invoiceKey = "AB12345678|1783065600|24536806";

function resetItemsToVersion9(db: LedgerDatabase, version: 9 | 10 = 9) {
  const sequenceColumnDefinition = version === 9
    ? "TEXT"
    : `INTEGER CHECK (
        item_sequence_number IS NULL
        OR (typeof(item_sequence_number) = 'integer' AND item_sequence_number >= 0)
      )`;
  for (const table of TYPED_STATEMENT_TABLES) {
    if (table === "personal_invoice_items") continue;
    db.exec(`
      ALTER TABLE ${table} ADD COLUMN raw_row_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE ${table} ADD COLUMN dedupe_status TEXT NOT NULL DEFAULT 'unique';
    `);
  }
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
      item_sequence_number ${sequenceColumnDefinition},
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
    DELETE FROM schema_migrations WHERE version >= 10;
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
  for (const table of TYPED_STATEMENT_TABLES) {
    if (
      table === "personal_invoices" || table === "personal_invoice_items"
    ) continue;
    db.exec(`DROP INDEX IF EXISTS uq_${table}_content_hash`);
  }
  if (version === 10) {
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, ?, ?)",
    ).run(
      "normalized_personal_invoice_item_sequence_numbers",
      "2026-01-01T00:00:00.000Z",
    );
  }
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

const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-db-migrations-"));
const legacyLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-sequence-migration-"),
);
const invalidLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-invalid-sequence-"),
);
const categoryLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-category-migration-"),
);
const dedupeLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-physical-dedupe-"),
);

try {
  const seeded = openLedgerDatabase(ledgerDir);
  seeded.exec(`
    DROP TABLE personal_invoice_items;
    DROP TABLE personal_invoices;
    DELETE FROM schema_migrations WHERE version >= 4;
  `);
  for (const table of TYPED_STATEMENT_TABLES) {
    if (
      table === "personal_invoices" || table === "personal_invoice_items"
    ) continue;
    seeded.exec(`
      ALTER TABLE ${table} ADD COLUMN raw_row_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE ${table} ADD COLUMN dedupe_status TEXT NOT NULL DEFAULT 'unique';
    `);
    seeded.exec(`DROP INDEX IF EXISTS uq_${table}_content_hash`);
  }
  seeded.close();

  const migrated = openLedgerDatabase(ledgerDir);
  const versions = migrated.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number }>;
  const invoiceColumns = migrated.prepare("PRAGMA table_info(personal_invoices)").all() as Array<{
    name: string;
  }>;
  const itemColumns = migrated.prepare("PRAGMA table_info(personal_invoice_items)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
  const commonStatementColumns = new Map(TYPED_STATEMENT_TABLES.map((table) => [
    table,
    migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>,
  ]));
  migrated.close();

  assert.deepEqual(
    versions.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  for (const [table, columns] of commonStatementColumns) {
    const names = new Set(columns.map((column) => column.name));
    assert.equal(names.has("dedupe_status"), false, table);
    assert.equal(names.has("raw_row_hash"), false, table);
    assert.equal(names.has("content_hash"), true, table);
    assert.equal(names.has("source_hash"), true, table);
    assert.equal(names.has("raw_payload_json"), true, table);
  }
  assert.ok(invoiceColumns.some((column) => column.name === "invoice_key"));
  assert.ok(itemColumns.some((column) => column.name === "item_key"));
  const sequenceColumn = itemColumns.find(
    (column) => column.name === "item_sequence_number",
  );
  assert.equal(sequenceColumn?.type, "INTEGER");
  const categoryColumn = itemColumns.find((column) => column.name === "category");
  assert.equal(categoryColumn?.notnull, 1);

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
  `).all().map((item) => ({ ...item })) as Array<{
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
  assert.ok(itemIndexes.some(
    (index) => index.name === "idx_personal_invoice_items_source_file_id",
  ));
  assert.ok(itemIndexes.some(
    (index) => index.name === "idx_personal_invoice_items_import_run_id",
  ));
  assert.ok(itemIndexes.some(
    (index) => index.name === "idx_personal_invoice_items_source",
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

  const categoryDb = openLedgerDatabase(categoryLedgerDir);
  resetItemsToVersion9(categoryDb, 10);
  const version10Columns = categoryDb.prepare(
    "PRAGMA table_info(personal_invoice_items)",
  ).all() as Array<{ name: string; type: string }>;
  assert.equal(
    version10Columns.some((column) => column.name === "category"),
    false,
  );
  assert.equal(
    version10Columns.find((column) => column.name === "item_sequence_number")?.type,
    "INTEGER",
  );
  assert.equal(
    (categoryDb.prepare(
      "SELECT version FROM schema_migrations WHERE version = 10",
    ).get() as { version: number } | undefined)?.version,
    10,
  );
  categoryDb.prepare(`
    UPDATE personal_invoices
    SET seller_name = '台灣中油股份有限公司'
    WHERE invoice_key = ?
  `).run(invoiceKey);
  insertLegacyItem(categoryDb, {
    id: "coffee",
    sourceRowIndex: 1,
    sequence: "1",
    importedAt: "2026-01-01T00:00:00.000Z",
    productName: "咖啡",
  });
  insertLegacyItem(categoryDb, {
    id: "fuel",
    sourceRowIndex: 2,
    sequence: "2",
    importedAt: "2026-01-01T00:00:00.000Z",
    productName: "unmatched item",
  });
  migrateLedgerDb(categoryDb);

  const migratedCategoryColumn = categoryDb.prepare(
    "PRAGMA table_info(personal_invoice_items)",
  ).all().find((column) => (
    (column as { name: string }).name === "category"
  )) as { type: string; notnull: number; dflt_value: string } | undefined;
  assert.equal(migratedCategoryColumn?.type, "TEXT");
  assert.equal(migratedCategoryColumn?.notnull, 1);
  assert.equal(migratedCategoryColumn?.dflt_value, "'other'");

  const categories = categoryDb.prepare(`
    SELECT item_product_name, category
    FROM personal_invoice_items
    ORDER BY item_sequence_number
  `).all().map((item) => ({ ...item })) as Array<{
    item_product_name: string;
    category: string;
  }>;
  assert.deepEqual(categories, [
    { item_product_name: "咖啡", category: "food" },
    { item_product_name: "unmatched item", category: "transport" },
  ]);
  assert.throws(
    () => categoryDb.prepare(`
      UPDATE personal_invoice_items SET category = 'invalid'
    `).run(),
    /CHECK constraint failed/,
  );
  categoryDb.close();

  const dedupeDb = openLedgerDatabase(dedupeLedgerDir);
  dedupeDb.exec("DELETE FROM schema_migrations WHERE version >= 12");
  for (const table of TYPED_STATEMENT_TABLES) {
    dedupeDb.exec(`
      ALTER TABLE ${table} ADD COLUMN raw_row_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE ${table} ADD COLUMN dedupe_status TEXT NOT NULL DEFAULT 'unique';
    `);
  }
  for (const table of TYPED_STATEMENT_TABLES) {
    if (
      table === "personal_invoices" || table === "personal_invoice_items"
    ) continue;
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
    "aaa-later-row", "tie-row-file", "a.csv", 2, "source-tie-row", "raw-tie-row",
    "duplicate", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
  );
  insertAccountRow.run(
    "tie-later-id", "tie-id-file", "a.csv", 1, "source-tie-id", "raw-tie-id",
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
  const invoiceIndexes = dedupeDb.prepare(
    "PRAGMA index_list(personal_invoices)",
  ).all() as Array<{ name: string }>;
  const invoiceItemIndexes = dedupeDb.prepare(
    "PRAGMA index_list(personal_invoice_items)",
  ).all() as Array<{ name: string }>;

  assert.deepEqual(retained, [{ statement_row_id: "canonical" }]);
  assert.ok(accountIndexes.some((index) => (
    index.name === "uq_account_transactions_content_hash" && index.unique === 1
  )));
  assert.equal(invoiceIndexes.some(
    (index) => index.name === "uq_personal_invoices_content_hash",
  ), false);
  assert.equal(invoiceItemIndexes.some(
    (index) => index.name === "uq_personal_invoice_items_content_hash",
  ), false);
  assert.throws(() => dedupeDb.prepare(`
    INSERT INTO account_transactions (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, currency
    ) VALUES ('blocked', 'blocked-file', 'run', 'c.csv', 1, 'source-blocked',
      'same-content', 'demo', 'statements', '{}',
      '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'TWD')
  `).run(), /UNIQUE constraint failed: account_transactions.content_hash/);
  dedupeDb.close();
} finally {
  for (const directory of [
    ledgerDir,
    legacyLedgerDir,
    invalidLedgerDir,
    categoryLedgerDir,
    dedupeLedgerDir,
  ]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
