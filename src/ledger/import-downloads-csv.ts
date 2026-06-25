import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";
import { z } from "zod";

const inputSchema = z.object({
  downloadsDir: z.string().default("downloads"),
  outputDir: z.string().default("data/ledger"),
  bankFilters: z.array(z.string()).default([]),
  productFilters: z.array(z.string()).default([]),
});

type Input = z.infer<typeof inputSchema>;
type RecordType =
  | "import_batch"
  | "import_result"
  | "import_run"
  | "import_run_event";

type FileMetadata = {
  path: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  sha256: string;
};

type SourceContext = {
  bank: string;
  product: string;
};

type CsvLayout = {
  strategy: "first-row-header" | "empty-or-metadata";
  headerRowIndex: number | null;
  dataStartRowIndex: number | null;
  warnings: string[];
};

type ParsedCsvRow = {
  sourceRowIndex: number;
  rawPayload: Record<string, string>;
};

type ParsedCsv = {
  sourceSheetName: string | null;
  csvLayout: CsvLayout;
  headers: string[];
  recordKeys: string[];
  rows: ParsedCsvRow[];
};

type FileImportSummary = {
  sourceFile: string;
  sourceRelativePath: string;
  sourceFileMetadata: FileMetadata;
  bank: string;
  product: string;
  sourceSheetName: string | null;
  csvLayout: CsvLayout;
  headers: string[];
  recordKeys: string[];
  rows: number;
};

type LedgerDatabase = InstanceType<typeof DatabaseSync>;

const RAW_LEDGER_SCHEMA_VERSION = "raw-ledger.v1";
const IMPORTER_NAME = "import-downloads-csv";
const IMPORTER_VERSION = "1";
const SQLITE_LEDGER_FILE = "ledger.sqlite";

function baseRecord(recordType: RecordType) {
  return {
    schemaVersion: RAW_LEDGER_SCHEMA_VERSION,
    recordType,
    importerName: IMPORTER_NAME,
    importerVersion: IMPORTER_VERSION,
  };
}

function parseParams(argv: string[]): Record<string, unknown> {
  const paramsIndex = argv.indexOf("--params");
  const inlineParams = argv.find((arg) => arg.startsWith("--params="));
  const rawParams =
    paramsIndex >= 0 ? argv[paramsIndex + 1] : inlineParams?.slice(9);

  if (!rawParams) return {};

  try {
    const parsed = JSON.parse(rawParams) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid --params JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function recordKeysForHeaders(headers: string[]): string[] {
  const recordKeys: string[] = [];
  const keyCounts = new Map<string, number>();

  for (let index = 0; index < headers.length; index += 1) {
    const baseKey = headers[index] || `column_${index + 1}`;
    const used = keyCounts.get(baseKey) ?? 0;
    keyCounts.set(baseKey, used + 1);
    recordKeys.push(used === 0 ? baseKey : `${baseKey}__${used + 1}`);
  }

  return recordKeys;
}

function toRecord(
  recordKeys: string[],
  row: unknown[],
): Record<string, string> {
  const record: Record<string, string> = {};

  for (let index = 0; index < recordKeys.length; index += 1) {
    record[recordKeys[index]] = normalizeCell(row[index]);
  }

  return record;
}

function inferContext(csvFile: string, downloadsDir: string): SourceContext {
  const rel = relative(downloadsDir, csvFile);
  const firstPart = rel.split(sep)[0] ?? "";
  const [bank, ...productParts] = firstPart.split("-");

  return {
    bank: bank || "unknown",
    product: productParts.length > 0 ? productParts.join("-") : "unknown",
  };
}

function matchesFilters(context: SourceContext, input: Input): boolean {
  const bank = context.bank.toLowerCase();
  const product = context.product.toLowerCase();
  const bankFilters = input.bankFilters.map((value) => value.toLowerCase());
  const productFilters = input.productFilters.map((value) =>
    value.toLowerCase(),
  );

  return (
    (bankFilters.length === 0 || bankFilters.includes(bank)) &&
    (productFilters.length === 0 || productFilters.includes(product))
  );
}

async function fileMetadata(path: string, rootDir: string): Promise<FileMetadata> {
  const fileStat = await stat(path);
  const fileBuffer = await readFile(path);

  return {
    path,
    relativePath: relative(rootDir, path),
    bytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    sha256: hashBytes(fileBuffer),
  };
}

async function listCsvFiles(downloadsDir: string): Promise<string[]> {
  const root = await stat(downloadsDir);
  if (!root.isDirectory()) return [];

  const csvFiles: string[] = [];
  const queue = [downloadsDir];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
        csvFiles.push(fullPath);
      }
    }
  }

  return csvFiles.sort();
}

function openLedgerDatabase(outputDir: string): LedgerDatabase {
  const db = new DatabaseSync(join(outputDir, SQLITE_LEDGER_FILE));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyLedgerMigrations(db);
  return db;
}

type TypedStatementTable =
  | "account_transactions"
  | "foreign_currency_transactions"
  | "credit_card_statement_lines"
  | "loan_transactions"
  | "fund_holdings"
  | "fund_buy_transactions"
  | "fund_redemption_transactions"
  | "fund_cash_dividends"
  | "fund_conversion_transactions"
  | "brokerage_holdings"
  | "brokerage_asset_summaries"
  | "brokerage_trade_transactions"
  | "unsupported_statement_rows";

const TYPED_STATEMENT_TABLES: TypedStatementTable[] = [
  "account_transactions",
  "foreign_currency_transactions",
  "credit_card_statement_lines",
  "loan_transactions",
  "fund_holdings",
  "fund_buy_transactions",
  "fund_redemption_transactions",
  "fund_cash_dividends",
  "fund_conversion_transactions",
  "brokerage_holdings",
  "brokerage_asset_summaries",
  "brokerage_trade_transactions",
  "unsupported_statement_rows",
];

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

function appliedMigrations(db: LedgerDatabase): Set<number> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((row) => row.version));
}

function applyLedgerMigrations(db: LedgerDatabase) {
  const applied = appliedMigrations(db);
  const migrations: Array<{
    version: number;
    name: string;
    up: (db: LedgerDatabase) => void;
  }> = [
    {
      version: 1,
      name: "typed_statement_schema",
      up: createTypedStatementSchema,
    },
  ];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
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
      investment_amount REAL,
      subscription_fx_rate REAL,
      subscription_nav REAL,
      subscription_fee REAL,
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

  for (const table of TYPED_STATEMENT_TABLES) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source_file_id ON ${table}(source_file_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_import_run_id ON ${table}(import_run_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source_relative_path, source_row_index)`);
  }
}

function insertRunEvent(db: LedgerDatabase, record: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO import_run_events (import_run_id, event_type, event_at, record_json) VALUES (?, ?, ?, ?)",
  ).run(
    String(record.importRunId ?? ""),
    String(record.eventType ?? ""),
    String(record.eventAt ?? ""),
    JSON.stringify(record),
  );
}

function insertImportRun(db: LedgerDatabase, record: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO import_runs (import_run_id, started_at, finished_at, record_json) VALUES (?, ?, ?, ?)",
  ).run(
    String(record.importRunId ?? ""),
    String(record.startedAt ?? ""),
    String(record.finishedAt ?? ""),
    JSON.stringify(record),
  );
}

function sqliteValue(value: unknown): string | number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  return String(value);
}

function insertRecord(db: LedgerDatabase, table: string, record: Record<string, unknown>) {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => sqliteValue(record[column])));
}

function sqliteAmount(value: unknown): number | null {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw || raw === "-" || raw === "--") return null;
  const negative =
    /^\(.*\)$/.test(raw) || raw.startsWith("-") || raw.endsWith("-");
  const normalized = raw
    .replace(/[,%\s]/g, "")
    .replace(/[()]/g, "")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return negative ? -amount : amount;
}

function payloadCell(payload: Record<string, unknown>, key: string): string {
  return String(payload[key] ?? "").trim();
}

function firstPayloadCell(
  payload: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = payloadCell(payload, key);
    if (value) return value;
  }
  return "";
}

function sourceFileIdForPath(sourceRelativePath: string): string {
  return hashBytes(stableStringify(["source-file", sourceRelativePath])).slice(0, 24);
}

function rowIdForSourceRow(
  sourceRelativePath: string,
  sourceRowIndex: number,
  rawRowHash: string,
): string {
  return hashBytes(
    stableStringify(["statement-row", sourceRelativePath, sourceRowIndex, rawRowHash]),
  ).slice(0, 32);
}

function currencyFromRelativePath(sourceRelativePath: string): string {
  const fileName = sourceRelativePath.split("/").pop() ?? "";
  const match = fileName.match(/-(USD|JPY|EUR|GBP|AUD|CAD|CHF|HKD|CNY)-/i);
  return match ? match[1].toUpperCase() : "TWD";
}

function statementTableForSource(
  sourceRelativePath: string,
  context: SourceContext,
): TypedStatementTable {
  const bankProduct = `${context.bank}/${context.product}`;
  const fileName = sourceRelativePath.split("/").pop() ?? "";

  if (bankProduct === "cathay/statements") return "account_transactions";
  if (bankProduct === "fubon/statements") return "account_transactions";
  if (bankProduct === "yuanta/statements") return "account_transactions";
  if (bankProduct === "cathay/foreign-statements") return "foreign_currency_transactions";
  if (bankProduct === "yuanta/foreign-currency-statements") {
    return "foreign_currency_transactions";
  }
  if (bankProduct.endsWith("/credit-card-statements")) {
    return "credit_card_statement_lines";
  }
  if (bankProduct.endsWith("/loan-statements")) return "loan_transactions";
  if (bankProduct === "yuanta/fund-statements") {
    if (fileName.startsWith("fund-holdings-")) return "fund_holdings";
    if (fileName.startsWith("fund-buy-transactions-")) {
      return "fund_buy_transactions";
    }
    if (fileName.startsWith("fund-redemption-transactions-")) {
      return "fund_redemption_transactions";
    }
    if (fileName.startsWith("fund-cash-dividends-")) return "fund_cash_dividends";
    if (fileName.startsWith("fund-conversion-transactions-")) {
      return "fund_conversion_transactions";
    }
  }
  if (bankProduct === "yuanta/trade-statements") {
    if (fileName.startsWith("holdings-")) return "brokerage_holdings";
    if (fileName.startsWith("asset-summaries-")) return "brokerage_asset_summaries";
    if (fileName.startsWith("trade-transactions-")) return "brokerage_trade_transactions";
  }
  return "unsupported_statement_rows";
}

function sourceFileRecordFromBatch(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sourceRelativePath = String(record.sourceRelativePath ?? "");
  return {
    source_file_id: sourceFileIdForPath(sourceRelativePath),
    import_run_id: String(record.importRunId ?? ""),
    source_file: String(record.sourceFile ?? ""),
    source_relative_path: sourceRelativePath,
    source_file_hash: String(record.sourceFileHash ?? ""),
    source_file_bytes: Number(record.sourceFileBytes ?? 0),
    source_file_modified_at: String(record.sourceFileModifiedAt ?? ""),
    imported_at: String(record.importedAt ?? ""),
    bank: String(record.bank ?? ""),
    product: String(record.product ?? ""),
    source_sheet_name: String(record.sourceSheetName ?? ""),
    csv_layout_json: JSON.stringify(record.csvLayout ?? {}),
    headers_json: JSON.stringify(record.headers ?? []),
    record_keys_json: JSON.stringify(record.recordKeys ?? []),
    related_raw_files_json: JSON.stringify(record.relatedRawFileRelativePaths ?? []),
    related_raw_file_metadata_json: JSON.stringify(record.relatedRawFileMetadata ?? []),
    row_count: Number(record.rowCount ?? 0),
    status: String(record.status ?? "completed"),
    record_json: JSON.stringify(record),
  };
}

function insertSourceFile(db: LedgerDatabase, record: Record<string, unknown>) {
  insertRecord(db, "source_files", sourceFileRecordFromBatch(record));
}

function commonTypedRowFields(
  sourceFileRecord: Record<string, unknown>,
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash?: string;
    sourceHash?: string;
    contentHash?: string;
    dedupeStatus?: string;
  },
) {
  const sourceRelativePath = String(sourceFileRecord.sourceRelativePath ?? "");
  const sourceFileHash = String(sourceFileRecord.sourceFileHash ?? "");
  const rawRowHash = row.rawRowHash ?? hashBytes(stableStringify(row.rawPayload));
  const sourceHash =
    row.sourceHash ??
    sourceHashForOccurrence(
      sourceRelativePath,
      sourceFileHash,
      row.sourceRowIndex,
      rawRowHash,
    );
  const contentHash =
    row.contentHash ??
    contentHashForRow(
      String(sourceFileRecord.bank ?? ""),
      String(sourceFileRecord.product ?? ""),
      row.rawPayload,
    );

  return {
    statement_row_id: rowIdForSourceRow(
      sourceRelativePath,
      row.sourceRowIndex,
      rawRowHash,
    ),
    source_file_id: sourceFileIdForPath(sourceRelativePath),
    import_run_id: String(sourceFileRecord.importRunId ?? ""),
    source_relative_path: sourceRelativePath,
    source_row_index: row.sourceRowIndex,
    source_hash: sourceHash,
    raw_row_hash: rawRowHash,
    content_hash: contentHash,
    bank: String(sourceFileRecord.bank ?? ""),
    product: String(sourceFileRecord.product ?? ""),
    dedupe_status: row.dedupeStatus ?? "unique",
    raw_payload_json: JSON.stringify(row.rawPayload),
    imported_at: String(sourceFileRecord.importedAt ?? ""),
  };
}

function typedFieldsForTable(
  table: TypedStatementTable,
  sourceRelativePath: string,
  rawPayload: Record<string, string>,
  headers: string[],
): Record<string, unknown> {
  switch (table) {
    case "account_transactions":
      return {
        account_name: payloadCell(rawPayload, "帳戶名稱"),
        account_number: payloadCell(rawPayload, "帳號"),
        currency: "TWD",
        accounting_date: payloadCell(rawPayload, "帳務日期"),
        transaction_date: firstPayloadCell(rawPayload, ["交易日期", "帳務日期"]),
        transaction_time: payloadCell(rawPayload, "交易時間"),
        description: firstPayloadCell(rawPayload, ["摘要", "交易說明"]),
        withdrawal_amount: sqliteAmount(payloadCell(rawPayload, "支出金額")),
        deposit_amount: sqliteAmount(payloadCell(rawPayload, "存入金額")),
        balance_after: sqliteAmount(firstPayloadCell(rawPayload, ["即時餘額", "帳面餘額"])),
        note: firstPayloadCell(rawPayload, ["附註", "備註"]),
        fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
      };
    case "foreign_currency_transactions":
      return {
        account_name: payloadCell(rawPayload, "帳戶名稱"),
        account_number: payloadCell(rawPayload, "帳號"),
        query_currency: payloadCell(rawPayload, "查詢幣別"),
        currency:
          firstPayloadCell(rawPayload, ["幣別", "查詢幣別"]) ||
          currencyFromRelativePath(sourceRelativePath),
        accounting_date: payloadCell(rawPayload, "帳務日期"),
        transaction_date: firstPayloadCell(rawPayload, ["交易日期", "帳務日期"]),
        transaction_time: payloadCell(rawPayload, "交易時間"),
        description: firstPayloadCell(rawPayload, ["摘要", "交易說明"]),
        withdrawal_amount: sqliteAmount(payloadCell(rawPayload, "支出金額")),
        deposit_amount: sqliteAmount(payloadCell(rawPayload, "存入金額")),
        balance_after: sqliteAmount(firstPayloadCell(rawPayload, ["即時餘額", "帳面餘額"])),
        note: firstPayloadCell(rawPayload, ["附註", "交易資訊", "備註"]),
        fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
      };
    case "credit_card_statement_lines":
      return {
        statement_type: sourceRelativePath.includes("unbilled") ? "unbilled" : "billed",
        statement_period: payloadCell(rawPayload, "statement_period"),
        card_number: firstPayloadCell(rawPayload, ["card_number", "信用卡號"]),
        card_label: firstPayloadCell(rawPayload, ["card_label", "信用卡名稱"]),
        consume_date: firstPayloadCell(rawPayload, ["consume_date", "消費日期"]),
        posting_date: firstPayloadCell(rawPayload, ["posting_date", "入帳日期"]),
        description: firstPayloadCell(rawPayload, ["description", "消費明細"]),
        country_currency: firstPayloadCell(rawPayload, ["foreign_currency", "國家/幣別"]),
        foreign_exchange_date: payloadCell(rawPayload, "外幣折算日"),
        foreign_currency: firstPayloadCell(rawPayload, ["foreign_currency", "國家/幣別"]),
        foreign_amount: sqliteAmount(firstPayloadCell(rawPayload, ["foreign_amount", "外幣金額"])),
        twd_amount: sqliteAmount(firstPayloadCell(rawPayload, ["twd_amount", "新臺幣金額"])),
        installment_action: payloadCell(rawPayload, "installment_action"),
        payment_status: firstPayloadCell(rawPayload, ["payment_status", "繳費狀態"]),
      };
    case "loan_transactions":
      return {
        account_number: payloadCell(rawPayload, "貸款帳戶"),
        trade_date: firstPayloadCell(rawPayload, ["交易日期", "交易日"]),
        posting_date: payloadCell(rawPayload, "記帳日"),
        item: firstPayloadCell(rawPayload, ["交易內容", "繳款項目"]),
        interest_start_date: firstPayloadCell(rawPayload, ["計息起日", "提息起日"]),
        interest_end_date: firstPayloadCell(rawPayload, ["計息止日", "提息迄日"]),
        amount: sqliteAmount(firstPayloadCell(rawPayload, ["異動金額", "交易金額"])),
        interest_rate: payloadCell(rawPayload, "利率"),
        balance_after: sqliteAmount(firstPayloadCell(rawPayload, ["餘額", "交易後餘額"])),
        overpayment: sqliteAmount(payloadCell(rawPayload, "溢繳款")),
        note: payloadCell(rawPayload, "備註"),
      };
    case "fund_holdings":
      return {
        data_type: payloadCell(rawPayload, "資料類別"),
        fund_id: payloadCell(rawPayload, "基金識別"),
        query_period: payloadCell(rawPayload, "查詢期間"),
        fund_name: payloadCell(rawPayload, "基金名稱"),
        fund_type: payloadCell(rawPayload, "基金類型"),
        currency: payloadCell(rawPayload, "投資幣別"),
        investment_amount: sqliteAmount(payloadCell(rawPayload, "投資金額")),
        market_value_without_dividend: sqliteAmount(payloadCell(rawPayload, "不含息參考市值")),
        unrealized_pnl_without_dividend: sqliteAmount(payloadCell(rawPayload, "不含息參考損益")),
        return_rate_without_dividend: payloadCell(rawPayload, "不含息參考報酬率"),
        unrealized_pnl_with_dividend: sqliteAmount(payloadCell(rawPayload, "含息參考損益")),
        return_rate_with_dividend: payloadCell(rawPayload, "含息參考報酬率"),
        holding_status: payloadCell(rawPayload, "狀態"),
      };
    case "fund_buy_transactions":
      return {
        data_type: payloadCell(rawPayload, "資料類別"),
        fund_id: payloadCell(rawPayload, "基金識別"),
        query_period: payloadCell(rawPayload, "查詢期間"),
        investment_date: payloadCell(rawPayload, "投資日期"),
        fund_name: payloadCell(rawPayload, "基金名稱"),
        transaction_number: payloadCell(rawPayload, "交易編號"),
        investment_amount: sqliteAmount(payloadCell(rawPayload, "投資金額")),
        subscription_fx_rate: sqliteAmount(payloadCell(rawPayload, "申購匯率")),
        subscription_nav: sqliteAmount(payloadCell(rawPayload, "申購淨值")),
        subscription_fee: sqliteAmount(payloadCell(rawPayload, "申購手續費")),
        point_discount: sqliteAmount(payloadCell(rawPayload, "點數折抵")),
        subscribed_units: sqliteAmount(payloadCell(rawPayload, "申購單位數")),
      };
    case "fund_redemption_transactions":
      return {
        data_type: payloadCell(rawPayload, "資料類別"),
        fund_id: payloadCell(rawPayload, "基金識別"),
        query_period: payloadCell(rawPayload, "查詢期間"),
        redemption_date: payloadCell(rawPayload, "贖回日期"),
        distribution_date: payloadCell(rawPayload, "分配日期"),
        fund_name: payloadCell(rawPayload, "基金名稱"),
        transaction_number: payloadCell(rawPayload, "交易編號"),
        redemption_investment_amount: sqliteAmount(payloadCell(rawPayload, "贖回投資金額")),
        redemption_units: sqliteAmount(payloadCell(rawPayload, "贖回單位數")),
        redemption_price: sqliteAmount(payloadCell(rawPayload, "贖回價格")),
        redemption_fx_rate: sqliteAmount(payloadCell(rawPayload, "贖回匯率")),
        trust_management_fee: sqliteAmount(payloadCell(rawPayload, "信託管理費")),
        short_term_fee: sqliteAmount(payloadCell(rawPayload, "短線費用")),
        deferred_fee: sqliteAmount(payloadCell(rawPayload, "遞延手續費")),
        deposit_account: payloadCell(rawPayload, "入帳帳號"),
        net_deposit_amount: sqliteAmount(payloadCell(rawPayload, "入帳淨額")),
        reference_pnl: sqliteAmount(payloadCell(rawPayload, "贖回參考損益")),
        reference_return_rate: payloadCell(rawPayload, "參考贖回報酬率"),
        note: payloadCell(rawPayload, "備註"),
      };
    case "fund_cash_dividends":
      return {
        data_type: payloadCell(rawPayload, "資料類別"),
        fund_id: payloadCell(rawPayload, "基金識別"),
        query_period: payloadCell(rawPayload, "查詢期間"),
        deposit_date: payloadCell(rawPayload, "入帳日期"),
        fund_name: payloadCell(rawPayload, "基金名稱"),
        transaction_number: payloadCell(rawPayload, "交易編號"),
        benchmark_date: payloadCell(rawPayload, "基準日期"),
        currency: payloadCell(rawPayload, "計價幣別"),
        benchmark_units: sqliteAmount(payloadCell(rawPayload, "基準單位數")),
        distribution_amount: sqliteAmount(payloadCell(rawPayload, "分配金額")),
        fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
        distribution_rate: payloadCell(rawPayload, "分配率"),
        deposit_account: payloadCell(rawPayload, "入帳帳號"),
      };
    case "fund_conversion_transactions":
      return {
        data_type: payloadCell(rawPayload, "資料類別"),
        fund_id: payloadCell(rawPayload, "基金識別"),
        query_period: payloadCell(rawPayload, "查詢期間"),
        conversion_out_date: payloadCell(rawPayload, "轉出日期"),
        conversion_in_date: payloadCell(rawPayload, "轉入日期"),
        transaction_number: payloadCell(rawPayload, "交易編號"),
        from_fund_name: payloadCell(rawPayload, "轉出基金"),
        to_fund_name: payloadCell(rawPayload, "轉入基金"),
        conversion_investment_amount: sqliteAmount(payloadCell(rawPayload, "轉換投資金額")),
        from_units: sqliteAmount(payloadCell(rawPayload, "轉出單位數")),
        to_units: sqliteAmount(payloadCell(rawPayload, "轉入單位數")),
        from_nav: sqliteAmount(payloadCell(rawPayload, "轉出基金淨值")),
        to_nav: sqliteAmount(payloadCell(rawPayload, "轉入基金淨值")),
        conversion_fx_rate: sqliteAmount(payloadCell(rawPayload, "轉換匯率")),
        short_term_fee: sqliteAmount(payloadCell(rawPayload, "短線費用")),
        bank_conversion_fee: sqliteAmount(payloadCell(rawPayload, "銀行轉換手續費")),
        fund_company_conversion_fee: sqliteAmount(payloadCell(rawPayload, "基金公司轉換手續費")),
      };
    case "brokerage_holdings":
      return {
        as_of_date: payloadCell(rawPayload, "as_of_date"),
        account_number: payloadCell(rawPayload, "account_number"),
        asset_type: payloadCell(rawPayload, "asset_type"),
        sub_category: payloadCell(rawPayload, "sub_category"),
        product_code: payloadCell(rawPayload, "product_code"),
        product_name: payloadCell(rawPayload, "product_name"),
        currency: payloadCell(rawPayload, "currency"),
        quantity: sqliteAmount(payloadCell(rawPayload, "quantity")),
        market_date: payloadCell(rawPayload, "market_date"),
        market_price: sqliteAmount(payloadCell(rawPayload, "market_price")),
        market_value_original: sqliteAmount(payloadCell(rawPayload, "market_value_original")),
        market_value_twd: sqliteAmount(payloadCell(rawPayload, "market_value_twd")),
        cost_price: sqliteAmount(payloadCell(rawPayload, "cost_price")),
        cost_amount: sqliteAmount(payloadCell(rawPayload, "cost_amount")),
        unrealized_pnl_original: sqliteAmount(payloadCell(rawPayload, "unrealized_pnl_original")),
        unrealized_pnl_twd: sqliteAmount(payloadCell(rawPayload, "unrealized_pnl_twd")),
        return_rate: payloadCell(rawPayload, "return_rate"),
        fx_rate: sqliteAmount(payloadCell(rawPayload, "fx_rate")),
      };
    case "brokerage_asset_summaries":
      return {
        as_of_date: payloadCell(rawPayload, "as_of_date"),
        asset_type: payloadCell(rawPayload, "asset_type"),
        asset_name: payloadCell(rawPayload, "asset_name"),
        asset_value_twd: sqliteAmount(payloadCell(rawPayload, "asset_value_twd")),
        unrealized_pnl_twd: sqliteAmount(payloadCell(rawPayload, "unrealized_pnl_twd")),
      };
    case "brokerage_trade_transactions":
      return {
        trade_date: payloadCell(rawPayload, "trade_date"),
        account_number: payloadCell(rawPayload, "account_number"),
        asset_type: payloadCell(rawPayload, "asset_type"),
        trade_type: payloadCell(rawPayload, "trade_type"),
        sub_category: payloadCell(rawPayload, "sub_category"),
        product_code: payloadCell(rawPayload, "product_code"),
        product_name: payloadCell(rawPayload, "product_name"),
        currency: payloadCell(rawPayload, "currency"),
        action: payloadCell(rawPayload, "action"),
        quantity: sqliteAmount(payloadCell(rawPayload, "quantity")),
        price: sqliteAmount(payloadCell(rawPayload, "price")),
        gross_amount: sqliteAmount(payloadCell(rawPayload, "gross_amount")),
        fee: sqliteAmount(payloadCell(rawPayload, "fee")),
        tax: sqliteAmount(payloadCell(rawPayload, "tax")),
        settlement_amount: sqliteAmount(payloadCell(rawPayload, "settlement_amount")),
        settlement_currency: payloadCell(rawPayload, "settlement_currency"),
        realized_pnl: sqliteAmount(payloadCell(rawPayload, "realized_pnl")),
        cost_amount: sqliteAmount(payloadCell(rawPayload, "cost_amount")),
      };
    case "unsupported_statement_rows":
      return {
        reason: "unsupported source file shape",
        headers_json: JSON.stringify(headers),
      };
  }
}

function insertTypedStatementRow(
  db: LedgerDatabase,
  sourceFileRecord: Record<string, unknown>,
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash?: string;
    sourceHash?: string;
    contentHash?: string;
    dedupeStatus?: string;
  },
) {
  const sourceRelativePath = String(sourceFileRecord.sourceRelativePath ?? "");
  const table = statementTableForSource(sourceRelativePath, {
    bank: String(sourceFileRecord.bank ?? ""),
    product: String(sourceFileRecord.product ?? ""),
  });
  insertRecord(db, table, {
    ...commonTypedRowFields(sourceFileRecord, row),
    ...typedFieldsForTable(
      table,
      sourceRelativePath,
      row.rawPayload,
      Array.isArray(sourceFileRecord.headers)
        ? (sourceFileRecord.headers as string[])
        : [],
    ),
  });
}

function importedSourceRelativePaths(db: LedgerDatabase): Set<string> {
  const rows = db
    .prepare("SELECT source_relative_path FROM source_files")
    .all() as Array<{ source_relative_path: string }>;
  return new Set(rows.map((row) => row.source_relative_path));
}

function hasAnyCell(row: unknown[]): boolean {
  return row.some((value) => normalizeCell(value) !== "");
}

function emptyCsvLayout(warnings: string[]): CsvLayout {
  return {
    strategy: "empty-or-metadata",
    headerRowIndex: null,
    dataStartRowIndex: null,
    warnings,
  };
}

function firstRowCsvLayout(matrix: unknown[][]): CsvLayout {
  if (matrix.length === 0 || !hasAnyCell(matrix[0])) {
    return emptyCsvLayout(["CSV has no header row."]);
  }
  return {
    strategy: "first-row-header",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    warnings: [],
  };
}

function parseCsvRows(csvText: string): ParsedCsv {
  const workbook = XLSX.read(csvText, { raw: true, type: "string" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      sourceSheetName: null,
      csvLayout: emptyCsvLayout(["CSV workbook has no worksheets."]),
      headers: [],
      recordKeys: [],
      rows: [],
    };
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(
    workbook.Sheets[sheetName],
    {
      defval: "",
      header: 1,
      raw: true,
    },
  );
  const csvLayout = firstRowCsvLayout(matrix);
  if (
    csvLayout.headerRowIndex === null ||
    csvLayout.dataStartRowIndex === null
  ) {
    return {
      sourceSheetName: sheetName,
      csvLayout,
      headers: [],
      recordKeys: [],
      rows: [],
    };
  }

  const headers = matrix[csvLayout.headerRowIndex].map(normalizeHeader);
  const recordKeys = recordKeysForHeaders(headers);
  const rows: ParsedCsvRow[] = [];

  for (
    let index = csvLayout.dataStartRowIndex;
    index < matrix.length;
    index += 1
  ) {
    const row = matrix[index];
    if (!row.some((value) => normalizeCell(value) !== "")) continue;
    rows.push({
      sourceRowIndex: index + 1,
      rawPayload: toRecord(recordKeys, row),
    });
  }

  return {
    sourceSheetName: sheetName,
    csvLayout,
    headers,
    recordKeys,
    rows,
  };
}

function contentHashForRow(
  bank: string,
  product: string,
  row: Record<string, string>,
): string {
  return hashBytes(stableStringify({ bank, product, row }));
}

function sourceHashForOccurrence(
  sourceRelativePath: string,
  sourceFileHash: string,
  sourceRowIndex: number,
  rawRowHash: string,
): string {
  return hashBytes(
    stableStringify({
      sourceRelativePath,
      sourceFileHash,
      sourceRowIndex,
      rawRowHash,
    }),
  );
}

async function importDownloadsCsv(rawInput: Record<string, unknown>) {
  const input = inputSchema.parse(rawInput);
  const downloadsDir = resolve(input.downloadsDir);
  const outputDir = resolve(input.outputDir);
  const sqlitePath = join(outputDir, SQLITE_LEDGER_FILE);
  const importRunId = randomUUID();
  const startedAt = new Date().toISOString();
  let activeSourceFile: string | null = null;

  await mkdir(outputDir, { recursive: true });
  const db = openLedgerDatabase(outputDir);
  insertRunEvent(db, {
    ...baseRecord("import_run_event"),
    importRunId,
    eventType: "started",
    eventAt: startedAt,
    downloadsDir,
    outputDir,
    bankFilters: input.bankFilters,
    productFilters: input.productFilters,
  });

  try {
    const importedSourceFiles = importedSourceRelativePaths(db);
    const sourceFileRecords: Record<string, unknown>[] = [];
    const statementRows: Array<{
      sourceFileRecord: Record<string, unknown>;
      row: {
        sourceRowIndex: number;
        rawPayload: Record<string, string>;
        rawRowHash: string;
        sourceHash: string;
        contentHash: string;
        dedupeStatus: "unique";
      };
    }> = [];
    const fileSummaries: FileImportSummary[] = [];

    let scannedCsvFiles = 0;
    let importedCsvFiles = 0;
    let skippedCsvFiles = 0;
    let importedRows = 0;

    for (const sourceFile of await listCsvFiles(downloadsDir)) {
      const context = inferContext(sourceFile, downloadsDir);
      if (!matchesFilters(context, input)) continue;

      activeSourceFile = sourceFile;
      scannedCsvFiles += 1;

      const sourceRelativePath = relative(downloadsDir, sourceFile);
      if (importedSourceFiles.has(sourceRelativePath)) {
        skippedCsvFiles += 1;
        continue;
      }

      const fileBuffer = await readFile(sourceFile);
      const sourceFileHash = hashBytes(fileBuffer);
      const parsedCsv = parseCsvRows(fileBuffer.toString("utf8"));
      const { sourceSheetName, csvLayout, headers, recordKeys, rows } =
        parsedCsv;
      const sourceFileMetadata = await fileMetadata(sourceFile, downloadsDir);

      const sourceFileRecord = {
        ...baseRecord("import_batch"),
        importRunId,
        importBatchId: randomUUID(),
        sourceFile,
        sourceRelativePath,
        sourceFileMetadata,
        sourceFileHash,
        sourceFileBytes: sourceFileMetadata.bytes,
        sourceFileModifiedAt: sourceFileMetadata.modifiedAt,
        importedAt: startedAt,
        status: "completed",
        bank: context.bank,
        product: context.product,
        sourceSheetName,
        csvLayout,
        headers,
        recordKeys,
        rowCount: rows.length,
      };
      sourceFileRecords.push(sourceFileRecord);
      importedCsvFiles += 1;

      for (const row of rows) {
        const { sourceRowIndex, rawPayload } = row;
        const rawRowHash = hashBytes(stableStringify(rawPayload));
        const sourceHash = sourceHashForOccurrence(
          sourceRelativePath,
          sourceFileHash,
          sourceRowIndex,
          rawRowHash,
        );
        const contentHash = contentHashForRow(
          context.bank,
          context.product,
          rawPayload,
        );
        statementRows.push({
          sourceFileRecord,
          row: {
            sourceRowIndex,
            rawPayload,
            rawRowHash,
            sourceHash,
            contentHash,
            dedupeStatus: "unique",
          },
        });
        importedRows += 1;
      }

      fileSummaries.push({
        sourceFile,
        sourceRelativePath,
        sourceFileMetadata,
        bank: context.bank,
        product: context.product,
        sourceSheetName,
        csvLayout,
        headers,
        recordKeys,
        rows: rows.length,
      });
    }

    if (scannedCsvFiles === 0) {
      throw new Error(
        "No CSV files matched the import filters.",
      );
    }

    const finishedAt = new Date().toISOString();
    const sourceFilesWritten = sourceFileRecords.length;
    const runRecord = {
      ...baseRecord("import_run"),
      importRunId,
      startedAt,
      finishedAt,
      downloadsDir,
      outputDir,
      bankFilters: input.bankFilters,
      productFilters: input.productFilters,
      scannedCsvFiles,
      importedCsvFiles,
      skippedCsvFiles,
      importedRows,
      sourceFilesWritten,
      sqlitePath,
    };
    const completedEvent = {
      ...baseRecord("import_run_event"),
      importRunId,
      eventType: "completed",
      eventAt: finishedAt,
      scannedCsvFiles,
      importedCsvFiles,
      skippedCsvFiles,
      importedRows,
      sourceFilesWritten,
    };
    db.exec("BEGIN");
    try {
      for (const sourceFileRecord of sourceFileRecords) {
        insertSourceFile(db, sourceFileRecord);
      }
      for (const item of statementRows) {
        insertTypedStatementRow(db, item.sourceFileRecord, item.row);
      }
      insertImportRun(db, runRecord);
      insertRunEvent(db, completedEvent);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const result = {
      ...baseRecord("import_result"),
      importRunId,
      startedAt,
      finishedAt,
      downloadsDir,
      sqlitePath,
      scannedCsvFiles,
      importedCsvFiles,
      skippedCsvFiles,
      importedRows,
      sourceFilesWritten,
      files: fileSummaries,
    };
    db.close();
    return result;
  } catch (error) {
    insertRunEvent(db, {
      ...baseRecord("import_run_event"),
      importRunId,
      eventType: "failed",
      eventAt: new Date().toISOString(),
      activeSourceFile,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    db.close();
    throw error;
  }
}

async function main() {
  const result = await importDownloadsCsv(parseParams(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
