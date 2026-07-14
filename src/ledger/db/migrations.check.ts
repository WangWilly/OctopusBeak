import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "./client.ts";
import { migrateLedgerDb } from "./migrations.ts";
import { TYPED_STATEMENT_TABLES } from "../source-csv-parsers.ts";

const invoiceKey = "AB12345678|1783065600|24536806";

function resetItemsToVersion9(db: LedgerDatabase, version: 9 | 10 = 9) {
  db.exec("DROP INDEX IF EXISTS uq_credit_card_statement_lines_semantic_key");
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
    DROP TABLE IF EXISTS exchange_rates;
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
const cardBackfillLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-card-backfill-"),
);
const invalidCardBackfillLedgerDir = mkdtempSync(
  join(tmpdir(), "ledger-db-invalid-card-backfill-"),
);

function insertLegacyCardCapture(
  db: LedgerDatabase,
  input: {
    source: string;
    capturedAt: string;
    card?: string;
    statementType?: string;
    bank?: string;
    product?: string;
    transactions: Array<{ id: string; amount: number }>;
  },
) {
  const insert = db.prepare(`
    INSERT INTO credit_card_statement_lines (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, statement_type, card_number,
      consume_date, description, twd_amount
    ) VALUES (?, ?, 'legacy-run', ?, ?, ?, ?, ?,
      ?, '{}', ?, ?, ?, ?, '2026-06-01', ?, ?)
  `);
  input.transactions.forEach((transaction, index) => insert.run(
    `${input.source}-${transaction.id}`,
    input.source,
    `${input.source}.csv`,
    index + 1,
    `source-hash-${input.source}`,
    `content-${input.source}-${transaction.id}`,
    input.bank ?? "esun",
    input.product ?? "credit-card-statements",
    input.capturedAt,
    input.capturedAt,
    input.statementType ?? "unbilled",
    input.card ?? "1234",
    transaction.id,
    transaction.amount,
  ));
}

function resetCardsToVersion14(db: LedgerDatabase) {
  db.exec(`
    DELETE FROM schema_migrations WHERE version >= 15;
    DELETE FROM credit_card_snapshots;
    DROP TABLE IF EXISTS exchange_rates;
    DROP TABLE IF EXISTS credit_card_capture_entries;
    DROP TABLE IF EXISTS credit_card_captures;
    DROP INDEX IF EXISTS uq_credit_card_statement_lines_content_occurrence;
    DROP INDEX IF EXISTS uq_credit_card_statement_lines_semantic_key;
    CREATE UNIQUE INDEX uq_credit_card_statement_lines_content_hash
      ON credit_card_statement_lines(content_hash);
    DROP INDEX uq_credit_card_snapshots_source_card_type;
    CREATE UNIQUE INDEX uq_credit_card_snapshots_source_card_type
      ON credit_card_snapshots(source_file_id, card_key, statement_type);
  `);
  db.exec(`
    ALTER TABLE credit_card_statement_lines DROP COLUMN content_key;
    ALTER TABLE credit_card_statement_lines DROP COLUMN occurrence_index;
    ALTER TABLE credit_card_statement_lines DROP COLUMN first_seen_at;
    ALTER TABLE credit_card_statement_lines DROP COLUMN last_seen_at;
    ALTER TABLE credit_card_snapshots DROP COLUMN capture_id;
  `);
}

try {
  const seeded = openLedgerDatabase(ledgerDir);
  seeded.exec(`
    DROP TABLE personal_invoice_items;
    DROP TABLE personal_invoices;
    DROP TABLE IF EXISTS exchange_rates;
    DELETE FROM schema_migrations WHERE version >= 4;
    DROP INDEX IF EXISTS uq_credit_card_statement_lines_semantic_key;
    DROP INDEX IF EXISTS uq_credit_card_statement_lines_content_occurrence;
    DROP TABLE IF EXISTS credit_card_capture_entries;
    DROP TABLE IF EXISTS credit_card_captures;
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
    migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>,
  ]));
  const snapshotColumns = migrated.prepare(
    "PRAGMA table_info(credit_card_snapshots)",
  ).all() as Array<{ name: string }>;
  const snapshotIndexes = migrated.prepare(
    "PRAGMA index_list(credit_card_snapshots)",
  ).all() as Array<{ name: string; unique: number }>;
  const snapshotIndexColumns = (index: string) => migrated.prepare(
    `PRAGMA index_info(${index})`,
  ).all() as Array<{ name: string }>;

  assert.deepEqual(
    versions.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  );
  const exchangeRateColumns = migrated.prepare(
    "PRAGMA table_info(exchange_rates)",
  ).all() as Array<{ name: string; notnull: number }>;
  assert.deepEqual(exchangeRateColumns.map((column) => column.name), [
    "rate_date",
    "currency",
    "twd_per_unit",
    "source",
    "fetched_at",
  ]);
  assert.ok(exchangeRateColumns.every((column) => column.notnull === 1));
  assert.throws(() => migrated.prepare(`
    INSERT INTO exchange_rates
      (rate_date, currency, twd_per_unit, source, fetched_at)
    VALUES
      ('2026-07-14', 'USD', 0, 'frankfurter-v2', '2026-07-14T00:00:00.000Z')
  `).run(), /CHECK constraint failed/);
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
  assert.deepEqual(snapshotColumns.map((column) => column.name), [
    "snapshot_id", "source_file_id", "bank", "product", "card_key",
    "statement_type", "captured_at", "as_of_date", "currency",
    "transaction_count", "total_amount", "capture_id",
  ]);
  const semanticKeyColumn = commonStatementColumns
    .get("credit_card_statement_lines")
    ?.find((column) => column.name === "semantic_key");
  assert.equal(semanticKeyColumn?.notnull, 0);
  assert.equal(snapshotIndexes.find(
    (index) => index.name === "uq_credit_card_snapshots_source_card_type",
  )?.unique, 1);
  assert.equal(snapshotIndexes.some(
    (index) => index.name === "idx_credit_card_snapshots_card_day",
  ), true);
  assert.deepEqual(
    snapshotIndexColumns("uq_credit_card_snapshots_source_card_type")
      .map((column) => column.name),
    ["source_file_id", "card_key", "statement_type", "as_of_date"],
  );
  assert.deepEqual(
    snapshotIndexColumns("idx_credit_card_snapshots_card_day")
      .map((column) => column.name),
    ["card_key", "statement_type", "as_of_date", "captured_at"],
  );
  const insertSnapshot = migrated.prepare(`
    INSERT INTO credit_card_snapshots (
      snapshot_id, source_file_id, bank, product, card_key, statement_type,
      captured_at, as_of_date, currency, transaction_count, total_amount
    ) VALUES (?, 'source', 'esun', 'cards', '3456', 'billed',
      '2026-07-01T00:00:00.000Z', '2026-07-01', 'TWD', 1, 100)
  `);
  insertSnapshot.run("snapshot-1");
  assert.throws(() => insertSnapshot.run("snapshot-2"), /UNIQUE constraint failed/);
  assert.throws(() => migrated.prepare(`
    INSERT INTO credit_card_snapshots (
      snapshot_id, source_file_id, bank, product, card_key, statement_type,
      captured_at, as_of_date, currency, transaction_count, total_amount
    ) VALUES ('invalid-type', 'other-source', 'esun', 'cards', '3456', 'other',
      '2026-07-01T00:00:00.000Z', '2026-07-01', 'TWD', 1, 100)
  `).run(), /CHECK constraint failed/);
  assert.throws(() => migrated.prepare(`
    INSERT INTO credit_card_snapshots (
      snapshot_id, source_file_id, bank, product, card_key, statement_type,
      captured_at, as_of_date, currency, transaction_count, total_amount
    ) VALUES ('invalid-count', 'other-source', 'esun', 'cards', '3456', 'billed',
      '2026-07-01T00:00:00.000Z', '2026-07-01', 'TWD', -1, 100)
  `).run(), /CHECK constraint failed/);
  migrated.close();

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
  dedupeDb.exec(`
    DROP TABLE IF EXISTS exchange_rates;
    DELETE FROM schema_migrations WHERE version >= 12;
  `);
  dedupeDb.exec("DROP INDEX IF EXISTS uq_credit_card_statement_lines_semantic_key");
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
  assert.deepEqual(retained, [{ statement_row_id: "canonical" }]);
  for (const table of TYPED_STATEMENT_TABLES) {
    const index = (dedupeDb.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
    }>).find((candidate) => candidate.name === `uq_${table}_content_hash`);
    if (
      table === "personal_invoices" || table === "personal_invoice_items"
      || table === "credit_card_statement_lines"
    ) {
      assert.equal(index, undefined, table);
    } else {
      assert.equal(index?.unique, 1, table);
    }
  }
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

  const cardDb = openLedgerDatabase(cardBackfillLedgerDir);
  resetCardsToVersion14(cardDb);
  const transactions = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `tx-${index + 1}`,
    amount: index + 1,
  }));
  insertLegacyCardCapture(cardDb, {
    source: "june-full", capturedAt: "2026-06-30T08:00:00.000Z", transactions: transactions(9),
  });
  insertLegacyCardCapture(cardDb, {
    source: "billed-history", capturedAt: "2026-06-30T07:00:00.000Z",
    card: "7777", statementType: "billed", transactions: transactions(1),
  });
  insertLegacyCardCapture(cardDb, {
    source: "june-subset", capturedAt: "2026-06-30T09:00:00.000Z", transactions: transactions(2),
  });
  insertLegacyCardCapture(cardDb, {
    source: "july-full", capturedAt: "2026-07-03T08:00:00.000Z", card: "5678", transactions: transactions(12),
  });
  insertLegacyCardCapture(cardDb, {
    source: "july-subset", capturedAt: "2026-07-03T09:00:00.000Z", card: "5678", transactions: transactions(1),
  });
  insertLegacyCardCapture(cardDb, {
    source: "equal-earlier", capturedAt: "2026-07-04T08:00:00.000Z", card: "9999", transactions: transactions(2),
  });
  insertLegacyCardCapture(cardDb, {
    source: "equal-latest", capturedAt: "2026-07-04T09:00:00.000Z", card: "9999", transactions: transactions(2),
  });
  insertLegacyCardCapture(cardDb, {
    source: "superset-latest", capturedAt: "2026-07-04T10:00:00.000Z", card: "9999", transactions: transactions(3),
  });
  insertLegacyCardCapture(cardDb, {
    source: "next-day-subset", capturedAt: "2026-07-05T08:00:00.000Z", card: "9999", transactions: transactions(1),
  });
  insertLegacyCardCapture(cardDb, {
    source: "two-day-source", capturedAt: "2026-07-06T08:00:00.000Z", card: "2222",
    transactions: [{ id: "day-one", amount: 10 }],
  });
  insertLegacyCardCapture(cardDb, {
    source: "two-day-source", capturedAt: "2026-07-07T08:00:00.000Z", card: "2222",
    transactions: [{ id: "day-two", amount: 20 }],
  });
  insertLegacyCardCapture(cardDb, {
    source: "esun-same-last4", capturedAt: "2026-07-08T08:00:00.000Z", card: "3333",
    bank: "esun", product: "esun-credit-card-statements",
    transactions: [{ id: "esun", amount: 30 }],
  });
  insertLegacyCardCapture(cardDb, {
    source: "cathay-same-last4", capturedAt: "2026-07-08T09:00:00.000Z", card: "3333",
    bank: "cathay", product: "cathay-credit-card-statements",
    transactions: [{ id: "cathay", amount: 40 }],
  });
  insertLegacyCardCapture(cardDb, {
    source: "legacy-valid-card", capturedAt: "2026-07-09T08:00:00.000Z", card: "4242",
    transactions: [{ id: "valid", amount: 50 }],
  });
  insertLegacyCardCapture(cardDb, {
    source: "legacy-blank-card", capturedAt: "2026-07-09T09:00:00.000Z", card: "",
    transactions: [{ id: "blank", amount: 60 }],
  });
  migrateLedgerDb(cardDb);
  const validLegacySnapshot = cardDb.prepare(`
    SELECT capture_id FROM credit_card_snapshots
    WHERE source_file_id = 'legacy-valid-card' AND card_key = '4242'
  `).get() as { capture_id: string | null } | undefined;
  const blankLegacySnapshot = cardDb.prepare(`
    SELECT capture_id FROM credit_card_snapshots
    WHERE source_file_id = 'legacy-blank-card' AND card_key = ''
  `).get() as { capture_id: string | null } | undefined;
  assert.match(validLegacySnapshot?.capture_id ?? "", /^legacy-display:/);
  assert.equal(blankLegacySnapshot?.capture_id, null);
  assert.equal((cardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_capture_entries
    WHERE source_file_id = 'legacy-blank-card' AND card_key = ''
  `).get() as { count: number }).count, 0);
  const legacyPayloadRows = cardDb.prepare(`
    SELECT statement_row_id, raw_payload_json
    FROM credit_card_statement_lines
    ORDER BY statement_row_id
  `).all().map((row) => ({ ...row }));
  const legacySnapshotCount = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots",
  ).get() as { count: number }).count;
  const legacyCaptureCountBeforeRerun = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count;
  const legacyEntryCountBeforeRerun = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count;
  const legacyProjectionCountBeforeRerun = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE snapshot_id LIKE 'legacy-display-unbilled:%'",
  ).get() as { count: number }).count;
  assert.equal(legacyProjectionCountBeforeRerun, 1);
  migrateLedgerDb(cardDb);
  assert.equal((cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count, legacyCaptureCountBeforeRerun);
  assert.equal((cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count, legacyEntryCountBeforeRerun);
  assert.equal((cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE snapshot_id LIKE 'legacy-display-unbilled:%'",
  ).get() as { count: number }).count, legacyProjectionCountBeforeRerun);

  const captureColumns = cardDb.prepare(
    "PRAGMA table_info(credit_card_captures)",
  ).all() as Array<{ name: string }>;
  const captureEntryColumns = cardDb.prepare(
    "PRAGMA table_info(credit_card_capture_entries)",
  ).all() as Array<{ name: string; pk: number }>;
  const captureEntryIndexes = cardDb.prepare(
    "PRAGMA index_list(credit_card_capture_entries)",
  ).all() as Array<{ name: string }>;
  const cardLineColumns = cardDb.prepare(
    "PRAGMA table_info(credit_card_statement_lines)",
  ).all() as Array<{ name: string }>;
  const cardSnapshotColumns = cardDb.prepare(
    "PRAGMA table_info(credit_card_snapshots)",
  ).all() as Array<{ name: string }>;
  const cardIndexes = cardDb.prepare(
    "PRAGMA index_list(credit_card_statement_lines)",
  ).all() as Array<{ name: string; unique: number }>;

  for (const name of [
    "capture_id", "bank", "product", "captured_at", "completeness_json",
  ]) {
    assert.ok(captureColumns.some((column) => column.name === name), name);
  }
  for (const name of [
    "capture_id", "statement_row_id", "source_file_id", "source_row_index",
  ]) {
    assert.ok(captureEntryColumns.some((column) => column.name === name), name);
  }
  assert.deepEqual(captureEntryColumns.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name), [
    "capture_id", "source_file_id", "source_row_index",
  ]);
  assert.ok(captureEntryIndexes.some(
    (index) => index.name === "idx_credit_card_capture_entries_latest",
  ));
  assert.throws(() => cardDb.prepare(`
    INSERT INTO credit_card_capture_entries (
      capture_id, statement_row_id, source_file_id, source_row_index,
      bank, product, card_key, statement_type
    ) VALUES ('capture', 'row', 'source', 1, 'bank', 'product', '1234', 'other')
  `).run(), /CHECK constraint failed/);
  for (const name of [
    "content_key", "occurrence_index", "first_seen_at", "last_seen_at",
  ]) {
    assert.ok(cardLineColumns.some((column) => column.name === name), name);
  }
  assert.ok(cardSnapshotColumns.some((column) => column.name === "capture_id"));
  assert.equal(cardIndexes.some(
    (index) => index.name === "uq_credit_card_statement_lines_semantic_key",
  ), false);
  const legacyCaptureCount = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count;
  const legacyEntryCount = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count;
  const legacySnapshotCountWithCapture = (cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE capture_id LIKE 'legacy-display:%'",
  ).get() as { count: number }).count;
  assert.ok(legacyCaptureCount > 0);
  assert.ok(legacyEntryCount > 0);
  assert.ok(legacySnapshotCountWithCapture > 0);
  assert.deepEqual(cardDb.prepare(`
    SELECT statement_row_id, raw_payload_json
    FROM credit_card_statement_lines
    ORDER BY statement_row_id
  `).all().map((row) => ({ ...row })), legacyPayloadRows);
  assert.equal((cardDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots",
  ).get() as { count: number }).count, legacySnapshotCount);
  const legacyBackfillRows = cardDb.prepare(`
    SELECT content_key, semantic_key, occurrence_index,
      first_seen_at, last_seen_at, imported_at
    FROM credit_card_statement_lines
  `).all() as Array<{
    content_key: string;
    semantic_key: string;
    occurrence_index: number;
    first_seen_at: string;
    last_seen_at: string;
    imported_at: string;
  }>;
  assert.ok(legacyBackfillRows.length > 0);
  for (const row of legacyBackfillRows) {
    assert.equal(row.content_key, row.semantic_key);
    assert.equal(row.occurrence_index, 0);
    assert.equal(row.first_seen_at, row.imported_at);
    assert.equal(row.last_seen_at, row.imported_at);
  }

  const contentOccurrenceIndex = cardIndexes.find(
    (index) => index.name === "uq_credit_card_statement_lines_content_occurrence",
  );
  assert.equal(contentOccurrenceIndex?.unique, 1);
  const cardRows = cardDb.prepare(`
    SELECT statement_row_id FROM credit_card_statement_lines
    ORDER BY statement_row_id
    LIMIT 2
  `).all() as Array<{ statement_row_id: string }>;
  assert.equal(cardRows.length, 2);
  const setContentOccurrence = cardDb.prepare(`
    UPDATE credit_card_statement_lines
    SET content_key = ?, occurrence_index = ?
    WHERE statement_row_id = ?
  `);
  setContentOccurrence.run("same-content", 0, cardRows[0].statement_row_id);
  setContentOccurrence.run("same-content", 1, cardRows[1].statement_row_id);
  assert.throws(
    () => setContentOccurrence.run("same-content", 0, cardRows[1].statement_row_id),
    /UNIQUE constraint failed/,
  );

  const snapshots = cardDb.prepare(`
    SELECT source_file_id, statement_type, as_of_date, currency,
      transaction_count, total_amount
    FROM credit_card_snapshots
    ORDER BY source_file_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(snapshots, [
    { source_file_id: "billed-history", statement_type: "billed", as_of_date: "2026-06-30", currency: "TWD", transaction_count: 1, total_amount: 1 },
    { source_file_id: "billed-history", statement_type: "unbilled", as_of_date: "2026-06-30", currency: "TWD", transaction_count: 1, total_amount: 1 },
    { source_file_id: "cathay-same-last4", statement_type: "unbilled", as_of_date: "2026-07-08", currency: "TWD", transaction_count: 1, total_amount: 40 },
    { source_file_id: "esun-same-last4", statement_type: "unbilled", as_of_date: "2026-07-08", currency: "TWD", transaction_count: 1, total_amount: 30 },
    { source_file_id: "july-full", statement_type: "unbilled", as_of_date: "2026-07-03", currency: "TWD", transaction_count: 12, total_amount: 78 },
    { source_file_id: "june-full", statement_type: "unbilled", as_of_date: "2026-06-30", currency: "TWD", transaction_count: 9, total_amount: 45 },
    { source_file_id: "legacy-blank-card", statement_type: "unbilled", as_of_date: "2026-07-09", currency: "TWD", transaction_count: 1, total_amount: 60 },
    { source_file_id: "legacy-valid-card", statement_type: "unbilled", as_of_date: "2026-07-09", currency: "TWD", transaction_count: 1, total_amount: 50 },
    { source_file_id: "next-day-subset", statement_type: "unbilled", as_of_date: "2026-07-05", currency: "TWD", transaction_count: 1, total_amount: 1 },
    { source_file_id: "two-day-source", statement_type: "unbilled", as_of_date: "2026-07-07", currency: "TWD", transaction_count: 1, total_amount: 20 },
  ]);
  assert.equal((cardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_statement_lines
    WHERE semantic_key IS NULL
  `).get() as { count: number }).count, 0);
  assert.deepEqual(cardDb.prepare(`
    SELECT statement_row_id FROM credit_card_statement_lines
    WHERE card_number = '9999' AND description = 'tx-1'
  `).all().map((row) => ({ ...row })), [
    { statement_row_id: "equal-earlier-tx-1" },
  ]);
  assert.equal(cardIndexes.some((index) => (
    index.name === "uq_credit_card_statement_lines_content_hash"
  )), false);
  cardDb.exec(`
    UPDATE credit_card_snapshots
    SET capture_id = 'legacy-display:2026-07-09'
    WHERE source_file_id = 'legacy-blank-card' AND card_key = '';
    INSERT INTO credit_card_capture_entries (
      capture_id, statement_row_id, source_file_id, source_row_index,
      bank, product, card_key, statement_type
    ) VALUES (
      'legacy-display:2026-07-09', 'legacy-display:legacy-blank-card',
      'legacy-blank-card', -999, 'esun', 'credit-card-statements', '', 'unbilled'
    );
    INSERT INTO credit_card_snapshots (
      snapshot_id, capture_id, source_file_id, bank, product, card_key,
      statement_type, captured_at, as_of_date, currency,
      transaction_count, total_amount
    ) VALUES (
      'legacy-blank-orphan', 'legacy-display:2026-07-10',
      'legacy-blank-orphan', 'legacy', 'credit-card-history', '',
      'unbilled', '2026-07-10T00:00:00.000Z', '2026-07-10', 'TWD', 0, 0
    );
    INSERT INTO credit_card_captures (
      capture_id, bank, product, captured_at, completeness_json
    ) VALUES (
      'legacy-display:2026-07-10', 'legacy', 'credit-card-history',
      '2026-07-10T00:00:00.000Z', '{}'
    );
    INSERT INTO credit_card_capture_entries (
      capture_id, statement_row_id, source_file_id, source_row_index,
      bank, product, card_key, statement_type
    ) VALUES (
      'legacy-display:2026-07-10', 'legacy-display:legacy-blank-orphan',
      'legacy-blank-orphan', -1, 'legacy', 'credit-card-history', '', 'unbilled'
    );
    DELETE FROM schema_migrations WHERE version = 20;
  `);
  migrateLedgerDb(cardDb);
  assert.equal((cardDb.prepare(`
    SELECT capture_id FROM credit_card_snapshots
    WHERE source_file_id = 'legacy-blank-card' AND card_key = ''
  `).get() as { capture_id: string | null }).capture_id, null);
  assert.equal((cardDb.prepare(`
    SELECT capture_id FROM credit_card_snapshots
    WHERE source_file_id = 'legacy-valid-card' AND card_key = '4242'
  `).get() as { capture_id: string | null }).capture_id, "legacy-display:2026-07-09");
  assert.equal((cardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_capture_entries
    WHERE card_key = '' AND capture_id LIKE 'legacy-display:%'
  `).get() as { count: number }).count, 0);
  assert.equal((cardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_captures
    WHERE capture_id = 'legacy-display:2026-07-09'
  `).get() as { count: number }).count, 1);
  assert.equal((cardDb.prepare(`
    SELECT capture_id FROM credit_card_snapshots
    WHERE snapshot_id = 'legacy-blank-orphan'
  `).get() as { capture_id: string | null }).capture_id, null);
  assert.equal((cardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_captures
    WHERE capture_id = 'legacy-display:2026-07-10'
  `).get() as { count: number }).count, 0);
  cardDb.close();

  const invalidCardDb = openLedgerDatabase(invalidCardBackfillLedgerDir);
  resetCardsToVersion14(invalidCardDb);
  insertLegacyCardCapture(invalidCardDb, {
    source: "invalid-card", capturedAt: "2026-07-06T08:00:00.000Z",
    statementType: "other", transactions: transactions(1),
  });
  assert.throws(() => migrateLedgerDb(invalidCardDb), /CHECK constraint failed/);
  assert.equal(invalidCardDb.prepare(`
    SELECT version FROM schema_migrations WHERE version = 15
  `).get(), undefined);
  assert.equal((invalidCardDb.prepare(`
    SELECT semantic_key FROM credit_card_statement_lines
    WHERE statement_row_id = 'invalid-card-tx-1'
  `).get() as { semantic_key: string | null }).semantic_key, null);
  assert.equal((invalidCardDb.prepare(`
    SELECT COUNT(*) AS count FROM credit_card_snapshots
  `).get() as { count: number }).count, 0);
  assert.equal((invalidCardDb.prepare(`
    SELECT COUNT(*) AS count FROM pragma_index_list('credit_card_statement_lines')
    WHERE name = 'uq_credit_card_statement_lines_content_hash'
  `).get() as { count: number }).count, 1);
  invalidCardDb.close();
} finally {
  for (const directory of [
    ledgerDir,
    legacyLedgerDir,
    invalidLedgerDir,
    categoryLedgerDir,
    dedupeLedgerDir,
    cardBackfillLedgerDir,
    invalidCardBackfillLedgerDir,
  ]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
