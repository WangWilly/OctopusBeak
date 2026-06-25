import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";
import { z } from "zod";
import {
  TYPED_STATEMENT_TABLES,
  createSourceCsvParser,
  type SourceMetadata,
} from "./source-csv-parsers.ts";

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
  sourceMetadata: SourceMetadata | null;
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

async function sidecarMetadata(csvFile: string): Promise<SourceMetadata | null> {
  const metadataPath = csvFile.replace(/\.csv$/i, ".json");
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SourceMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
  const headers = Array.isArray(sourceFileRecord.headers)
    ? (sourceFileRecord.headers as string[])
    : [];
  const parser = createSourceCsvParser({
    bank: String(sourceFileRecord.bank ?? ""),
    product: String(sourceFileRecord.product ?? ""),
    sourceRelativePath,
    metadata: (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    headers,
  });
  insertRecord(db, parser.table, {
    ...commonTypedRowFields(sourceFileRecord, row),
    ...parser.parseRow(row.rawPayload),
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
      const sourceMetadata = await sidecarMetadata(sourceFile);

      const sourceFileRecord = {
        ...baseRecord("import_batch"),
        importRunId,
        importBatchId: randomUUID(),
        sourceFile,
        sourceRelativePath,
        sourceFileMetadata,
        sourceMetadata,
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
        sourceMetadata,
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
