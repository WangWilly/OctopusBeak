import {
  normalizeCurrencyCode,
  sqliteAmount,
  TYPED_STATEMENT_TABLES,
} from "../source-csv-parsers.ts";
import { contentHashForRow } from "../content-hash.ts";
import { classifyPersonalInvoiceItem } from "../../lib/spending/categories.ts";
import type { LedgerDatabase } from "./client.ts";

type LedgerMigration = {
  version: number;
  name: string;
  up: (db: LedgerDatabase) => void;
};

const COMMON_ROW_COLUMNS = `
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
`;

function ensureSchemaMigrationsTable(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedMigrations(db: LedgerDatabase): Set<number> {
  ensureSchemaMigrationsTable(db);
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((row) => row.version));
}

function recordMigration(db: LedgerDatabase, migration: LedgerMigration) {
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  ).run(migration.version, migration.name, new Date().toISOString());
}

function createTypedStatementSchema(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_run_id TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_runs_run_id ON import_runs(import_run_id);

    CREATE TABLE IF NOT EXISTS import_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_run_events_run_id ON import_run_events(import_run_id);

    CREATE TABLE IF NOT EXISTS source_files (
      source_file_id TEXT PRIMARY KEY,
      import_run_id TEXT NOT NULL,
      source_file TEXT,
      source_relative_path TEXT NOT NULL UNIQUE,
      source_file_hash TEXT NOT NULL,
      source_file_bytes INTEGER NOT NULL,
      source_file_modified_at TEXT,
      imported_at TEXT NOT NULL,
      bank TEXT NOT NULL,
      product TEXT NOT NULL,
      source_sheet_name TEXT,
      csv_layout_json TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      record_keys_json TEXT NOT NULL,
      related_raw_files_json TEXT NOT NULL,
      related_raw_file_metadata_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_files_import_run_id ON source_files(import_run_id);
    CREATE INDEX IF NOT EXISTS idx_source_files_bank_product ON source_files(bank, product);

    CREATE TABLE IF NOT EXISTS account_transactions (
      ${COMMON_ROW_COLUMNS},
      account_name TEXT,
      account_number TEXT,
      currency TEXT NOT NULL DEFAULT 'TWD',
      accounting_date TEXT,
      transaction_date TEXT,
      transaction_time TEXT,
      description TEXT,
      withdrawal_amount REAL,
      deposit_amount REAL,
      balance_after REAL,
      note TEXT,
      fx_rate REAL
    );

    CREATE TABLE IF NOT EXISTS foreign_currency_transactions (
      ${COMMON_ROW_COLUMNS},
      account_name TEXT,
      account_number TEXT,
      query_currency TEXT,
      currency TEXT NOT NULL,
      accounting_date TEXT,
      transaction_date TEXT,
      transaction_time TEXT,
      description TEXT,
      withdrawal_amount REAL,
      deposit_amount REAL,
      balance_after REAL,
      note TEXT,
      fx_rate REAL
    );

    CREATE TABLE IF NOT EXISTS credit_card_statement_lines (
      ${COMMON_ROW_COLUMNS},
      statement_type TEXT NOT NULL,
      statement_period TEXT,
      card_number TEXT,
      card_label TEXT,
      consume_date TEXT,
      posting_date TEXT,
      description TEXT,
      country_currency TEXT,
      foreign_exchange_date TEXT,
      foreign_currency TEXT,
      foreign_amount REAL,
      twd_amount REAL,
      installment_action TEXT,
      payment_status TEXT
    );

    CREATE TABLE IF NOT EXISTS loan_transactions (
      ${COMMON_ROW_COLUMNS},
      account_number TEXT,
      trade_date TEXT,
      posting_date TEXT,
      item TEXT,
      interest_start_date TEXT,
      interest_end_date TEXT,
      amount REAL,
      interest_rate TEXT,
      balance_after REAL,
      overpayment REAL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS fund_holdings (
      ${COMMON_ROW_COLUMNS},
      data_type TEXT,
      fund_id TEXT,
      query_period TEXT,
      fund_name TEXT,
      fund_type TEXT,
      currency TEXT,
      investment_amount REAL,
      market_value_without_dividend REAL,
      unrealized_pnl_without_dividend REAL,
      return_rate_without_dividend TEXT,
      unrealized_pnl_with_dividend REAL,
      return_rate_with_dividend TEXT,
      holding_status TEXT
    );

    CREATE TABLE IF NOT EXISTS fund_buy_transactions (
      ${COMMON_ROW_COLUMNS},
      data_type TEXT,
      fund_id TEXT,
      query_period TEXT,
      investment_date TEXT,
      fund_name TEXT,
      transaction_number TEXT,
      currency TEXT,
      investment_amount REAL,
      subscription_fx_rate REAL,
      subscription_nav REAL,
      subscription_fee REAL,
      subscription_fee_currency TEXT,
      point_discount REAL,
      subscribed_units REAL
    );

    CREATE TABLE IF NOT EXISTS fund_redemption_transactions (
      ${COMMON_ROW_COLUMNS},
      data_type TEXT,
      fund_id TEXT,
      query_period TEXT,
      redemption_date TEXT,
      distribution_date TEXT,
      fund_name TEXT,
      transaction_number TEXT,
      redemption_investment_amount REAL,
      redemption_units REAL,
      redemption_price REAL,
      redemption_fx_rate REAL,
      trust_management_fee REAL,
      short_term_fee REAL,
      deferred_fee REAL,
      deposit_account TEXT,
      net_deposit_amount REAL,
      reference_pnl REAL,
      reference_return_rate TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS fund_cash_dividends (
      ${COMMON_ROW_COLUMNS},
      data_type TEXT,
      fund_id TEXT,
      query_period TEXT,
      deposit_date TEXT,
      fund_name TEXT,
      transaction_number TEXT,
      benchmark_date TEXT,
      currency TEXT,
      benchmark_units REAL,
      distribution_amount REAL,
      distribution_currency TEXT,
      fx_rate REAL,
      distribution_rate TEXT,
      deposit_account TEXT
    );

    CREATE TABLE IF NOT EXISTS fund_conversion_transactions (
      ${COMMON_ROW_COLUMNS},
      data_type TEXT,
      fund_id TEXT,
      query_period TEXT,
      conversion_out_date TEXT,
      conversion_in_date TEXT,
      transaction_number TEXT,
      from_fund_name TEXT,
      to_fund_name TEXT,
      conversion_investment_amount REAL,
      from_units REAL,
      to_units REAL,
      from_nav REAL,
      to_nav REAL,
      conversion_fx_rate REAL,
      short_term_fee REAL,
      bank_conversion_fee REAL,
      fund_company_conversion_fee REAL
    );

    CREATE TABLE IF NOT EXISTS brokerage_holdings (
      ${COMMON_ROW_COLUMNS},
      as_of_date TEXT,
      account_number TEXT,
      asset_type TEXT,
      sub_category TEXT,
      product_code TEXT,
      product_name TEXT,
      currency TEXT,
      quantity REAL,
      market_date TEXT,
      market_price REAL,
      market_value_original REAL,
      market_value_twd REAL,
      cost_price REAL,
      cost_amount REAL,
      unrealized_pnl_original REAL,
      unrealized_pnl_twd REAL,
      return_rate TEXT,
      fx_rate REAL
    );

    CREATE TABLE IF NOT EXISTS brokerage_asset_summaries (
      ${COMMON_ROW_COLUMNS},
      as_of_date TEXT,
      asset_type TEXT,
      asset_name TEXT,
      asset_value_twd REAL,
      unrealized_pnl_twd REAL
    );

    CREATE TABLE IF NOT EXISTS brokerage_trade_transactions (
      ${COMMON_ROW_COLUMNS},
      trade_date TEXT,
      account_number TEXT,
      asset_type TEXT,
      trade_type TEXT,
      sub_category TEXT,
      product_code TEXT,
      product_name TEXT,
      currency TEXT,
      action TEXT,
      quantity REAL,
      price REAL,
      gross_amount REAL,
      fee REAL,
      tax REAL,
      settlement_amount REAL,
      settlement_currency TEXT,
      realized_pnl REAL,
      cost_amount REAL
    );

    CREATE TABLE IF NOT EXISTS unsupported_statement_rows (
      ${COMMON_ROW_COLUMNS},
      reason TEXT NOT NULL,
      headers_json TEXT NOT NULL
    );
  `);

  createPersonalInvoiceStatementTables(db);

  for (const table of TYPED_STATEMENT_TABLES) {
    createTypedStatementIndexesFor(db, table);
  }
}

function createTypedStatementIndexesFor(db: LedgerDatabase, table: string) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source_file_id ON ${table}(source_file_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_import_run_id ON ${table}(import_run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source_relative_path, source_row_index)`);
}

function createPersonalInvoiceStatementTables(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_invoices (
      ${COMMON_ROW_COLUMNS},
      invoice_key TEXT NOT NULL UNIQUE,
      carrier_customized_name TEXT,
      issued_at INTEGER,
      invoice_id TEXT NOT NULL,
      amount REAL,
      status TEXT,
      rebated INTEGER NOT NULL DEFAULT 0,
      seller_business_account_number TEXT,
      seller_name TEXT,
      seller_addr TEXT,
      buyer_business_account_number TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_invoice_id
      ON personal_invoices(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_issued_at
      ON personal_invoices(issued_at);
    CREATE INDEX IF NOT EXISTS idx_personal_invoices_seller
      ON personal_invoices(seller_business_account_number);

    CREATE TABLE IF NOT EXISTS personal_invoice_items (
      ${COMMON_ROW_COLUMNS},
      item_key TEXT NOT NULL UNIQUE,
      invoice_key TEXT NOT NULL,
      item_sequence_number INTEGER
        CHECK (
          item_sequence_number IS NULL
          OR (
            typeof(item_sequence_number) = 'integer'
            AND item_sequence_number >= 0
          )
        ),
      item_quantity REAL,
      item_unit_price REAL,
      item_paid_amount REAL,
      item_product_name TEXT,
      category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('food', 'daily', 'transport', 'shopping', 'home', 'leisure', 'other')),
      FOREIGN KEY (invoice_key) REFERENCES personal_invoices(invoice_key)
    );
    CREATE INDEX IF NOT EXISTS idx_personal_invoice_items_invoice_key
      ON personal_invoice_items(invoice_key);
    CREATE INDEX IF NOT EXISTS idx_personal_invoice_items_product_name
      ON personal_invoice_items(item_product_name);
  `);
}

function addPersonalInvoiceStatementTables(db: LedgerDatabase) {
  createPersonalInvoiceStatementTables(db);
  createTypedStatementIndexesFor(db, "personal_invoices");
  createTypedStatementIndexesFor(db, "personal_invoice_items");
}

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
  createTypedStatementIndexesFor(db, "personal_invoice_items");
}

function addPersonalInvoiceItemCategories(db: LedgerDatabase) {
  const categoryColumn = (
    db.prepare("PRAGMA table_info(personal_invoice_items)").all() as Array<{
      name: string;
    }>
  ).find((column) => column.name === "category");
  if (!categoryColumn) {
    db.exec(`
      ALTER TABLE personal_invoice_items
        ADD COLUMN category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('food', 'daily', 'transport', 'shopping', 'home', 'leisure', 'other'));
    `);
  }

  const items = db.prepare(`
    SELECT
      items.item_key,
      items.item_product_name AS product_name,
      invoices.seller_name,
      invoices.seller_addr
    FROM personal_invoice_items AS items
    JOIN personal_invoices AS invoices USING (invoice_key)
  `).all() as Array<{
    item_key: string;
    product_name: string | null;
    seller_name: string | null;
    seller_addr: string | null;
  }>;
  const updateCategory = db.prepare(
    "UPDATE personal_invoice_items SET category = ? WHERE item_key = ?",
  );
  for (const item of items) {
    updateCategory.run(classifyPersonalInvoiceItem({
      productName: item.product_name ?? "",
      sellerName: item.seller_name ?? "",
      sellerAddr: item.seller_addr ?? "",
    }), item.item_key);
  }
}

function createDashboardIndexes(db: LedgerDatabase) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_transactions_account_date
    ON account_transactions(account_number, transaction_date);

    CREATE INDEX IF NOT EXISTS idx_foreign_currency_transactions_account_date
    ON foreign_currency_transactions(account_number, currency, transaction_date);

    CREATE INDEX IF NOT EXISTS idx_credit_card_statement_lines_card_date
    ON credit_card_statement_lines(card_number, consume_date);

    CREATE INDEX IF NOT EXISTS idx_loan_transactions_account_date
    ON loan_transactions(account_number, trade_date);

    CREATE INDEX IF NOT EXISTS idx_brokerage_holdings_account_date
    ON brokerage_holdings(account_number, as_of_date);
  `);
}

function tableColumns(db: LedgerDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(
  db: LedgerDatabase,
  table: string,
  column: string,
  definition: string,
) {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function parseRawPayload(rawPayloadJson: string): Record<string, unknown> {
  try {
    return JSON.parse(rawPayloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function addFundTransactionCurrencyColumns(db: LedgerDatabase) {
  addColumnIfMissing(db, "fund_buy_transactions", "currency", "currency TEXT");
  addColumnIfMissing(
    db,
    "fund_buy_transactions",
    "subscription_fee_currency",
    "subscription_fee_currency TEXT",
  );
  addColumnIfMissing(
    db,
    "fund_cash_dividends",
    "distribution_currency",
    "distribution_currency TEXT",
  );

  const fundBuyRows = db
    .prepare("SELECT statement_row_id, raw_payload_json FROM fund_buy_transactions")
    .all() as Array<{ statement_row_id: string; raw_payload_json: string }>;
  const updateFundBuy = db.prepare(`
    UPDATE fund_buy_transactions
    SET currency = ?,
        investment_amount = COALESCE(?, investment_amount),
        subscription_fee = COALESCE(?, subscription_fee),
        subscription_fee_currency = ?
    WHERE statement_row_id = ?
  `);
  for (const row of fundBuyRows) {
    const payload = parseRawPayload(row.raw_payload_json);
    const currency = normalizeCurrencyCode(payload["投資金額"], "TWD");
    updateFundBuy.run(
      currency,
      sqliteAmount(payload["投資金額"]),
      sqliteAmount(payload["申購手續費"]),
      normalizeCurrencyCode(payload["申購手續費"], currency),
      row.statement_row_id,
    );
  }

  const dividendRows = db
    .prepare("SELECT statement_row_id, raw_payload_json FROM fund_cash_dividends")
    .all() as Array<{ statement_row_id: string; raw_payload_json: string }>;
  const updateDividend = db.prepare(`
    UPDATE fund_cash_dividends
    SET currency = ?,
        distribution_amount = COALESCE(?, distribution_amount),
        distribution_currency = ?
    WHERE statement_row_id = ?
  `);
  for (const row of dividendRows) {
    const payload = parseRawPayload(row.raw_payload_json);
    updateDividend.run(
      normalizeCurrencyCode(payload["計價幣別"]),
      sqliteAmount(payload["分配金額"]),
      normalizeCurrencyCode(payload["分配金額"], "TWD"),
      row.statement_row_id,
    );
  }
}

function normalizeContentHashesAndDedupe(db: LedgerDatabase) {
  const rows: Array<{
    table_name: string;
    statement_row_id: string;
    bank: string;
    product: string;
    raw_payload_json: string;
    imported_at: string;
    source_relative_path: string;
    source_row_index: number;
  }> = [];

  for (const table of TYPED_STATEMENT_TABLES) {
    if (!tableColumns(db, table).has("statement_row_id")) continue;
    rows.push(
      ...(db
        .prepare(`
          SELECT
            '${table}' AS table_name,
            statement_row_id,
            bank,
            product,
            raw_payload_json,
            imported_at,
            source_relative_path,
            source_row_index
          FROM ${table}
        `)
        .all() as typeof rows),
    );
  }

  rows.sort((left, right) =>
    left.imported_at.localeCompare(right.imported_at) ||
    left.source_relative_path.localeCompare(right.source_relative_path) ||
    left.source_row_index - right.source_row_index ||
    left.statement_row_id.localeCompare(right.statement_row_id),
  );

  const seen = new Set<string>();
  for (const row of rows) {
    const contentHash = contentHashForRow(
      row.bank,
      row.product,
      parseRawPayload(row.raw_payload_json),
    );
    const dedupeStatus = seen.has(contentHash) ? "duplicate" : "unique";
    seen.add(contentHash);
    db.prepare(`
      UPDATE ${row.table_name}
      SET content_hash = ?, dedupe_status = ?
      WHERE statement_row_id = ?
    `).run(contentHash, dedupeStatus, row.statement_row_id);
  }
}

function createMaicoinSchema(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maicoin_sync_runs (
      sync_run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      sub_account TEXT NOT NULL,
      wallet_types_json TEXT NOT NULL,
      statement_enabled INTEGER NOT NULL,
      statement_limit INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maicoin_account_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      sub_account TEXT NOT NULL,
      wallet_type TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL,
      locked REAL NOT NULL,
      staked REAL,
      principal REAL,
      interest REAL,
      total_quantity REAL NOT NULL,
      price_market TEXT,
      price_currency TEXT,
      price REAL,
      value_twd REAL,
      price_at TEXT,
      raw_account_json TEXT NOT NULL,
      raw_price_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_maicoin_account_snapshots_run
    ON maicoin_account_snapshots(sync_run_id);
    CREATE INDEX IF NOT EXISTS idx_maicoin_account_snapshots_latest
    ON maicoin_account_snapshots(sub_account, wallet_type, currency, captured_at);

    CREATE TABLE IF NOT EXISTS maicoin_statement_rows (
      statement_id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      wallet_type TEXT,
      row_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      occurred_at TEXT,
      currency TEXT,
      amount REAL,
      fee REAL,
      fee_currency TEXT,
      market TEXT,
      side TEXT,
      price REAL,
      value_twd REAL,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_maicoin_statement_rows_run
    ON maicoin_statement_rows(sync_run_id);
    CREATE INDEX IF NOT EXISTS idx_maicoin_statement_rows_time
    ON maicoin_statement_rows(row_type, occurred_at);
  `);
}

function addMaicoinStatementValueTwd(db: LedgerDatabase) {
  addColumnIfMissing(db, "maicoin_statement_rows", "value_twd", "value_twd REAL");
}

function createAutomationTaskRuns(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_task_runs (
      task_run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      script TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      signal TEXT,
      error_message TEXT,
      log_path TEXT NOT NULL,
      log_tail TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_task_runs_latest
    ON automation_task_runs(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_automation_task_runs_status
    ON automation_task_runs(status, started_at);
  `);
}

function addAutomationTaskRunsStartedAtIndex(db: LedgerDatabase) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_automation_task_runs_started_at
    ON automation_task_runs(started_at DESC)
  `);
}

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

const migrations: LedgerMigration[] = [
  {
    version: 1,
    name: "typed_statement_schema",
    up: createTypedStatementSchema,
  },
  {
    version: 2,
    name: "dashboard_indexes",
    up: createDashboardIndexes,
  },
  {
    version: 3,
    name: "fund_transaction_currency_columns",
    up: addFundTransactionCurrencyColumns,
  },
  {
    version: 4,
    name: "normalized_content_hash_dedupe",
    up: normalizeContentHashesAndDedupe,
  },
  {
    version: 5,
    name: "maicoin_api_snapshots",
    up: createMaicoinSchema,
  },
  {
    version: 6,
    name: "maicoin_statement_value_twd",
    up: addMaicoinStatementValueTwd,
  },
  {
    version: 7,
    name: "automation_task_runs",
    up: createAutomationTaskRuns,
  },
  {
    version: 8,
    name: "automation_task_runs_started_at_index",
    up: addAutomationTaskRunsStartedAtIndex,
  },
  {
    version: 9,
    name: "personal_invoice_statement_tables",
    up: addPersonalInvoiceStatementTables,
  },
  {
    version: 10,
    name: "normalized_personal_invoice_item_sequence_numbers",
    up: normalizePersonalInvoiceItemSequenceNumbers,
  },
  {
    version: 11,
    name: "personal_invoice_item_categories",
    up: addPersonalInvoiceItemCategories,
  },
  {
    version: 12,
    name: "physical_content_hash_deduplication",
    up: physicallyDeduplicateStatementRows,
  },
];

export function migrateLedgerDb(db: LedgerDatabase) {
  const applied = appliedMigrations(db);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.exec("BEGIN");
    try {
      migration.up(db);
      recordMigration(db, migration);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
