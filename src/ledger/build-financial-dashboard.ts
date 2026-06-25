import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";
import { z } from "zod";

const inputSchema = z.object({
  ledgerDir: z.string().default("data/ledger"),
  outputDir: z.string().default("data/ledger"),
  includeDuplicates: z.boolean().default(false),
});

const SQLITE_LEDGER_FILE = "ledger.sqlite";
const TYPED_STATEMENT_TABLES = [
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
] as const;

type Input = z.infer<typeof inputSchema>;

type RawRecord = Record<string, unknown>;
type LedgerDatabase = InstanceType<typeof DatabaseSync>;
type TypedStatementTable = (typeof TYPED_STATEMENT_TABLES)[number];

type BatchRecord = RawRecord & {
  importRunId?: string;
  importBatchId: string;
  sourceRelativePath: string;
  sourceFile?: string;
  bank: string;
  product: string;
  rowCount: number;
  importedAt?: string;
  csvLayout?: {
    strategy?: string;
    warnings?: string[];
  };
};

type ImportRunRecord = RawRecord & {
  importRunId: string;
  startedAt?: string;
  finishedAt?: string;
};

type RawTransactionOccurrence = RawRecord & {
  importRunId?: string;
  importBatchId: string;
  sourceHash: string;
  contentHash?: string;
  sourceRelativePath: string;
  sourceRowIndex: number;
  bank: string;
  product: string;
  dedupeStatus: "unique" | "duplicate";
  rawPayload: Record<string, string>;
  sourceAccountHint?: string;
};

type NormalizedTransaction = {
  id: string;
  sourceHash: string;
  sourceRelativePath: string;
  sourceRowIndex: number;
  institution: string;
  product: string;
  parserId: string;
  type:
    | "deposit"
    | "foreign_deposit"
    | "loan"
    | "credit_card"
    | "investment"
    | "brokerage";
  accountId: string;
  accountLabel: string;
  currency: string;
  date: string | null;
  occurredAt: string | null;
  description: string;
  status: "posted" | "unbilled" | "payment" | "detail" | "dividend" | "unknown";
  inflow: number | null;
  outflow: number | null;
  amountSigned: number | null;
  balanceAfter: number | null;
  includeInCashFlow: boolean;
  warnings: string[];
};

type AssetPosition = {
  id: string;
  institution: string;
  product: string;
  parserId: string;
  assetClass:
    | "cash"
    | "foreign_cash"
    | "loan"
    | "credit_card"
    | "fund"
    | "brokerage"
    | "brokerage_rollup";
  accountId: string;
  label: string;
  currency: string;
  value: number;
  valueTwd: number | null;
  valueSign: "asset" | "liability" | "informational";
  includeInTotals: boolean;
  asOfDate: string | null;
  asOfDateTime: string | null;
  sourceRelativePath: string;
  sourceRowIndex: number;
  confidence: "high" | "medium" | "low";
  warnings: string[];
};

type FinancialTotals = {
  includedByCurrency: Record<
    string,
    {
      assets: number;
      liabilities: number;
      net: number;
    }
  >;
  informationalByCurrency: Record<string, number>;
};

type SnapshotAccountValue = {
  id: string;
  institution: string;
  product: string;
  assetClass: AssetPosition["assetClass"];
  accountId: string;
  label: string;
  currency: string;
  value: number;
  valueSign: AssetPosition["valueSign"];
  includeInTotals: boolean;
};

type DailyAccountChange = SnapshotAccountValue & {
  snapshotDate: string;
  signedValue: number;
  previousSnapshotDate: string | null;
  previousValue: number | null;
  previousSignedValue: number | null;
  change: number;
};

type AssetSnapshot = {
  importRunId: string;
  importedAt: string;
  snapshotDate: string;
  totals: FinancialTotals;
  positionCount: number;
  includedPositionCount: number;
  accounts: SnapshotAccountValue[];
};

type DailyAssetHistoryPoint = {
  date: string;
  importRunId: string;
  importedAt: string;
  assets: CurrencyBucket;
  liabilities: CurrencyBucket;
  netAssets: CurrencyBucket;
  netChange: CurrencyBucket;
  positionCount: number;
  accountChanges: DailyAccountChange[];
};

type SnapshotHistory = {
  snapshots: AssetSnapshot[];
  daily: DailyAssetHistoryPoint[];
};

type Classification = {
  row: RawTransactionOccurrence;
  transactions: NormalizedTransaction[];
  positions: AssetPosition[];
  auditOnlyReason?: string;
  unsupportedReason?: string;
};

type QualityIssue = {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  sourceRelativePath?: string;
  sourceRowIndex?: number;
};

type FinancialModel = {
  schemaVersion: "financial-model.v1";
  generatedAt: string;
  sourceLedgerDir: string;
  sourceLedgerStore: "sqlite";
  counts: {
    rawRows: number;
    uniqueRows: number;
    duplicateRows: number;
    normalizedTransactions: number;
    assetPositions: number;
    includedPositions: number;
    duplicateNormalizedTransactions: number;
    assetSnapshots: number;
    auditOnlyRows: number;
    unsupportedRows: number;
  };
  totals: FinancialTotals;
  dashboard: DashboardView;
  parserCoverage: Record<
    string,
    {
      rows: number;
      parsedRows: number;
      auditOnlyRows: number;
      unsupportedRows: number;
      transactions: number;
      positions: number;
    }
  >;
  assetPositions: AssetPosition[];
  normalizedTransactions: NormalizedTransaction[];
  snapshotHistory: SnapshotHistory;
  unsupportedRows: Array<{
    bank: string;
    product: string;
    sourceRelativePath: string;
    sourceRowIndex: number;
    reason: string;
  }>;
  auditOnlyRows: Array<{
    bank: string;
    product: string;
    sourceRelativePath: string;
    sourceRowIndex: number;
    reason: string;
  }>;
  sourceBatches: {
    count: number;
    layoutStrategies: Record<string, number>;
  };
  quality: {
    status: "pass" | "warn" | "fail";
    issues: QualityIssue[];
  };
};

type CurrencyBucket = Record<string, number>;

type DashboardMetric = {
  label: string;
  value?: string;
  amounts?: CurrencyBucket;
};

type DashboardAccount = {
  id: string;
  label: string;
  kind: "account" | "credit_card" | "loan" | "fund" | "brokerage";
  institution: string;
  product: string;
  metrics: DashboardMetric[];
  positionIds: string[];
  transactionIds: string[];
  childAssetIds: string[];
};

type DashboardInstitution = {
  id: string;
  label: string;
  groups: Array<{
    kind: DashboardAccount["kind"];
    label: string;
    accounts: DashboardAccount[];
  }>;
};

type DashboardView = {
  overview: {
    assets: {
      totalTwdAssets: CurrencyBucket;
      totalForeignAssets: CurrencyBucket;
      totalInvestmentAssets: CurrencyBucket;
    };
    liabilities: {
      unbilledCreditCardAmount: CurrencyBucket;
      loanTotalBalance: CurrencyBucket;
    };
    netAssets: CurrencyBucket;
  };
  institutions: DashboardInstitution[];
};

function parseParams(argv: string[]): Record<string, unknown> {
  const paramsIndex = argv.indexOf("--params");
  const inlineParams = argv.find((arg) => arg.startsWith("--params="));
  const rawParams =
    paramsIndex >= 0 ? argv[paramsIndex + 1] : inlineParams?.slice(9);

  if (!rawParams) return {};

  const parsed = JSON.parse(rawParams) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function readSqliteRecords<T>(db: LedgerDatabase, table: string): T[] {
  if (table !== "import_runs") {
    throw new Error(`Unsupported ledger SQLite table: ${table}`);
  }

  const rows = db
    .prepare(`SELECT record_json FROM ${table} ORDER BY id`)
    .all() as Array<{ record_json: string }>;
  return rows.map((row) => JSON.parse(row.record_json) as T);
}

function sqliteTableExists(db: LedgerDatabase, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(table);
  return Boolean(row);
}

function readSqliteSourceFiles(db: LedgerDatabase): BatchRecord[] {
  if (!sqliteTableExists(db, "source_files")) return [];

  const rows = db
    .prepare(
      `SELECT
        source_file_id,
        import_run_id,
        source_file,
        source_relative_path,
        source_file_hash,
        source_file_bytes,
        source_file_modified_at,
        imported_at,
        bank,
        product,
        source_sheet_name,
        csv_layout_json,
        headers_json,
        record_keys_json,
        related_raw_files_json,
        related_raw_file_metadata_json,
        row_count,
        status,
        record_json
      FROM source_files
      ORDER BY imported_at, source_relative_path`,
    )
    .all() as Array<{
    source_file_id: string;
    import_run_id: string;
    source_file: string | null;
    source_relative_path: string;
    source_file_hash: string;
    source_file_bytes: number;
    source_file_modified_at: string | null;
    imported_at: string;
    bank: string;
    product: string;
    source_sheet_name: string | null;
    csv_layout_json: string;
    headers_json: string;
    record_keys_json: string;
    related_raw_files_json: string;
    related_raw_file_metadata_json: string;
    row_count: number;
    status: string;
    record_json: string;
  }>;

  return rows.map((row) => {
    const record = JSON.parse(row.record_json || "{}") as Record<string, unknown>;
    return {
      ...record,
      importRunId: row.import_run_id,
      importBatchId: row.source_file_id,
      sourceFile: row.source_file ?? "",
      sourceRelativePath: row.source_relative_path,
      sourceFileHash: row.source_file_hash,
      sourceFileBytes: row.source_file_bytes,
      sourceFileModifiedAt: row.source_file_modified_at ?? "",
      importedAt: row.imported_at,
      bank: row.bank,
      product: row.product,
      sourceSheetName: row.source_sheet_name ?? "",
      csvLayout: JSON.parse(row.csv_layout_json || "{}"),
      headers: JSON.parse(row.headers_json || "[]"),
      recordKeys: JSON.parse(row.record_keys_json || "[]"),
      relatedRawFileRelativePaths: JSON.parse(
        row.related_raw_files_json || "[]",
      ),
      relatedRawFileMetadata: JSON.parse(
        row.related_raw_file_metadata_json || "[]",
      ),
      rowCount: row.row_count,
      status: row.status,
    } as BatchRecord;
  });
}

function readTypedStatementRowsFromTable(
  db: LedgerDatabase,
  table: TypedStatementTable,
): RawTransactionOccurrence[] {
  if (!sqliteTableExists(db, table)) return [];

  const rows = db
    .prepare(
      `SELECT
        source_file_id,
        import_run_id,
        source_relative_path,
        source_row_index,
        source_hash,
        raw_row_hash,
        content_hash,
        bank,
        product,
        dedupe_status,
        raw_payload_json
      FROM ${table}
      ORDER BY imported_at, source_relative_path, source_row_index`,
    )
    .all() as Array<{
    source_file_id: string;
    import_run_id: string;
    source_relative_path: string;
    source_row_index: number;
    source_hash: string;
    raw_row_hash: string;
    content_hash: string;
    bank: string;
    product: string;
    dedupe_status: "unique" | "duplicate";
    raw_payload_json: string;
  }>;

  return rows.map((row) => ({
    importRunId: row.import_run_id,
    importBatchId: row.source_file_id,
    sourceHash: row.source_hash,
    rawRowHash: row.raw_row_hash,
    contentHash: row.content_hash,
    sourceRelativePath: row.source_relative_path,
    sourceRowIndex: row.source_row_index,
    bank: row.bank,
    product: row.product,
    dedupeStatus: row.dedupe_status,
    rawPayload: JSON.parse(row.raw_payload_json || "{}") as Record<string, string>,
  }));
}

function readSqliteTypedRows(db: LedgerDatabase): RawTransactionOccurrence[] {
  return TYPED_STATEMENT_TABLES.flatMap((table) =>
    readTypedStatementRowsFromTable(db, table),
  );
}

async function readLedgerRecords(ledgerDir: string): Promise<{
  source: "sqlite";
  batches: BatchRecord[];
  importRuns: ImportRunRecord[];
  rawRows: RawTransactionOccurrence[];
}> {
  const sqlitePath = join(ledgerDir, SQLITE_LEDGER_FILE);
  if (!existsSync(sqlitePath)) {
    throw new Error(`Missing SQLite ledger: ${sqlitePath}`);
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return {
      source: "sqlite",
      batches: readSqliteSourceFiles(db),
      importRuns: readSqliteRecords<ImportRunRecord>(db, "import_runs"),
      rawRows: readSqliteTypedRows(db),
    };
  } finally {
    db.close();
  }
}

async function buildSourceAccountHints(
  batches: BatchRecord[],
): Promise<Map<string, string>> {
  const hints = new Map<string, string>();

  for (const batch of batches) {
    const hint = await readSourceAccountHint(batch);
    if (hint) hints.set(batch.sourceRelativePath, hint);
  }

  return hints;
}

async function readSourceAccountHint(batch: BatchRecord): Promise<string | null> {
  if (!["fubon"].includes(batch.bank)) return null;

  try {
    const csvText = await readFile(String(batch.sourceFile), "utf8");
    const workbook = XLSX.read(csvText, { raw: false, type: "string" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return null;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      defval: "",
      header: 1,
      raw: false,
    });
    const searchRows = rows.slice(0, 12);

    for (const row of searchRows) {
      const label = String(row[0] ?? "").trim();
      const value = String(row[1] ?? "").trim();
      if (!value) continue;
      if (/^(帳號|貸款帳號)$/.test(label)) return maskIdentifier(value);
    }
  } catch {
    return null;
  }

  return null;
}

function stableId(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

function cell(row: Record<string, string>, key: string): string {
  return String(row[key] ?? "").trim();
}

function firstCell(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = cell(row, key);
    if (value) return value;
  }
  return "";
}

function parseAmount(value: unknown): number | null {
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

function parseAmountToken(
  value: unknown,
  token: "first" | "last" = "first",
): number | null {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  const matches = raw.match(/-?\(?\d[\d,]*(?:\.\d+)?\)?-?/g);
  if (!matches || matches.length === 0) return null;

  return parseAmount(token === "last" ? matches[matches.length - 1] : matches[0]);
}

function currencyFromText(value: unknown, fallback = "TWD"): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (/台幣|臺幣|新台幣|新臺幣|NTD|TWD|NT\$/i.test(raw)) return "TWD";
  if (/美金|美元|美圓|USD/i.test(raw)) return "USD";
  if (/日圓|日幣|日元|JPY/i.test(raw)) return "JPY";
  return normalizeCurrency(raw, fallback);
}

function parseDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return formatDate(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
    );
  }

  const rocCompact = raw.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (rocCompact) {
    return formatDate(
      Number(rocCompact[1]) + 1911,
      Number(rocCompact[2]),
      Number(rocCompact[3]),
    );
  }

  const slash = raw.match(/^(\d{1,4})[/-](\d{1,2})(?:[/-](\d{1,4}))?$/);
  if (slash && slash[3]) {
    const first = Number(slash[1]);
    const middle = Number(slash[2]);
    const last = Number(slash[3]);

    if (first >= 1900) return formatDate(first, middle, last);
    if (first >= 100) return formatDate(first + 1911, middle, last);
    if (last < 100) return formatDate(last + 2000, first, middle);
    return formatDate(last, first, middle);
  }

  return null;
}

function parseDateTime(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const timeMatch = raw.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  const dateText = raw.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?.*$/, "");
  const date = parseDate(dateText);
  if (!date) return null;

  if (!timeMatch) return `${date}T00:00:00`;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return `${date}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}`;
}

function rowDateTime(row: RawTransactionOccurrence, fallbackDate: string | null) {
  const p = row.rawPayload;
  const directTime = firstCell(p, [
    "交易時間",
    "transaction_time",
    "datetime",
    "date_time",
  ]);
  const directDateTime = parseDateTime(directTime);
  if (directDateTime) return directDateTime;

  const dateText =
    firstCell(p, [
      "帳務日期",
      "交易日期",
      "交易日",
      "記帳日",
      "消費日期",
      "入帳日期",
      "posting_date",
      "consume_date",
      "trade_date",
      "as_of_date",
      "投資日期",
      "轉出日期",
      "轉入日期",
      "分配日期",
    ]) ||
    fallbackDate ||
    "";
  if (directTime && /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(directTime)) {
    const combined = parseDateTime(`${dateText} ${directTime}`);
    if (combined) return combined;
  }

  return parseDateTime(dateText) ?? (fallbackDate ? `${fallbackDate}T00:00:00` : null);
}

function parseStatementPeriod(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{3,4})[/-](\d{1,2})/);
  if (!match) return null;

  const year = Number(match[1]);
  return formatDate(year < 1900 ? year + 1911 : year, Number(match[2]), 1);
}

function formatDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function institutionLabel(bank: string): string {
  const labels: Record<string, string> = {
    cathay: "Cathay",
    fubon: "Fubon",
    yuanta: "Yuanta",
  };
  return labels[bank] ?? bank;
}

function normalizeCurrency(value: string, fallback = "TWD"): string {
  const raw = value.trim();
  if (!raw) return fallback;
  const normalized = raw.toUpperCase();
  const aliases: Record<string, string> = {
    "台幣": "TWD",
    "臺幣": "TWD",
    "新台幣": "TWD",
    "新臺幣": "TWD",
    "NTD": "TWD",
    "NT$": "TWD",
    "美元": "USD",
    "美金": "USD",
    "美圓": "USD",
    "日圓": "JPY",
    "日幣": "JPY",
    "日元": "JPY",
  };
  return aliases[raw] ?? aliases[normalized] ?? normalized;
}

function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return `****${digits.slice(-4)}`;

  const compact = value.replace(/[^\p{L}\p{N}_-]/gu, "");
  if (!compact) return "unknown";
  if (compact.length <= 4) return compact;
  return `****${compact.slice(-4)}`;
}

function sourceAccount(row: RawTransactionOccurrence, explicit = ""): string {
  if (explicit) return maskIdentifier(explicit);
  if (row.sourceAccountHint) return row.sourceAccountHint;
  const sourcePathHint = sourceAccountFromPath(row);
  if (sourcePathHint) return sourcePathHint;
  return `source:${row.sourceRelativePath}`;
}

function sourceAccountFromPath(row: RawTransactionOccurrence): string | null {
  const fileName = row.sourceRelativePath.split("/").pop() ?? "";
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/-\d{10,}$/, "");

  if (`${row.bank}/${row.product}` === "yuanta/loan-statements") {
    const accountText = cell(row.rawPayload, "貸款帳戶");
    if (accountText) return maskIdentifier(accountText);
  }

  const longDigits = stem.match(/\d{6,}/);
  return longDigits ? maskIdentifier(longDigits[0]) : null;
}

function currencyFromSourcePath(row: RawTransactionOccurrence): string | null {
  const fileName = row.sourceRelativePath.split("/").pop() ?? "";
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/-\d{10,}$/, "");
  const token = stem
    .split(/[-_]/)
    .map((part) => part.trim())
    .find((part) => /^[A-Za-z]{3}$/.test(part));
  return token ? normalizeCurrency(token, "UNKNOWN") : null;
}

function fundAccountId(label: string): string {
  return stableId(["fund", label.trim()]);
}

function baseTransaction(
  row: RawTransactionOccurrence,
  parserId: string,
  type: NormalizedTransaction["type"],
  accountId: string,
  currency: string,
  date: string | null,
): Omit<
  NormalizedTransaction,
  | "description"
  | "inflow"
  | "outflow"
  | "amountSigned"
  | "balanceAfter"
  | "status"
  | "includeInCashFlow"
  | "warnings"
> {
  return {
    id: stableId(["transaction", row.sourceHash, parserId]),
    sourceHash: row.sourceHash,
    sourceRelativePath: row.sourceRelativePath,
    sourceRowIndex: row.sourceRowIndex,
    institution: institutionLabel(row.bank),
    product: row.product,
    parserId,
    type,
    accountId,
    accountLabel: accountId,
    currency,
    date,
    occurredAt: rowDateTime(row, date),
  };
}

function positionFromRow(
  row: RawTransactionOccurrence,
  parserId: string,
  assetClass: AssetPosition["assetClass"],
  accountId: string,
  currency: string,
  value: number,
  valueSign: AssetPosition["valueSign"],
  asOfDate: string | null,
  options: {
    label?: string;
    valueTwd?: number | null;
    includeInTotals?: boolean;
    confidence?: AssetPosition["confidence"];
    warnings?: string[];
  } = {},
): AssetPosition {
  return {
    id: stableId(["position", parserId, accountId, currency, row.sourceHash]),
    institution: institutionLabel(row.bank),
    product: row.product,
    parserId,
    assetClass,
    accountId,
    label: options.label ?? accountId,
    currency,
    value,
    valueTwd: options.valueTwd ?? null,
    valueSign,
    includeInTotals: options.includeInTotals ?? true,
    asOfDate,
    asOfDateTime: rowDateTime(row, asOfDate),
    sourceRelativePath: row.sourceRelativePath,
    sourceRowIndex: row.sourceRowIndex,
    confidence: options.confidence ?? "high",
    warnings: options.warnings ?? [],
  };
}

function classifyDepositRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "cathay/statements" && cell(p, "帳務日期")) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "帳務日期"));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "即時餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "cathay.deposit.v2", "deposit", accountId, "TWD", date),
      description: [cell(p, "摘要"), cell(p, "附註")].filter(Boolean).join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "cathay/foreign-statements" && cell(p, "帳務日期")) {
    const accountId = sourceAccount(row);
    const currency = currencyFromSourcePath(row) ?? "UNKNOWN";
    const date = parseDate(cell(p, "帳務日期"));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "即時餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "cathay.foreign-deposit.v2",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: [cell(p, "摘要"), cell(p, "附註")].filter(Boolean).join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "fubon/statements") {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "帳務日期"));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "即時餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "摘要"), cell(p, "附註")].filter(Boolean).join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/statements") {
    const accountId = sourceAccount(row, cell(p, "帳號"));
    const date = parseDate(firstCell(p, ["帳務日期", "交易日期"]));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "帳面餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "交易說明"), cell(p, "備註")].filter(Boolean).join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/foreign-currency-statements") {
    const accountId = sourceAccount(row, cell(p, "帳號"));
    const currency = normalizeCurrency(cell(p, "幣別"), "UNKNOWN");
    const date = parseDate(firstCell(p, ["帳務日期", "交易日期"]));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "帳面餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.foreign-deposit.v1",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: [cell(p, "交易說明"), cell(p, "交易資訊")].filter(Boolean).join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return null;
}

function classifyLoanRow(row: RawTransactionOccurrence): Classification | null {
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "fubon/loan-statements" && cell(p, "餘額")) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "交易日期"));
    const amount = parseAmount(cell(p, "異動金額"));
    const balanceAfter = parseAmount(cell(p, "餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "交易內容"),
      inflow: null,
      outflow: amount,
      amountSigned: amount === null ? null : -amount,
      balanceAfter,
      status: "detail",
      includeInCashFlow: false,
      warnings: balanceAfter === null ? ["missing loan balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/loan-statements") {
    const accountId = sourceAccount(row, cell(p, "貸款帳戶"));
    const date = parseDate(cell(p, "交易日"));
    const amount = parseAmount(cell(p, "交易金額"));
    const balanceAfter = parseAmount(cell(p, "交易後餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "繳款項目"),
      inflow: null,
      outflow: amount,
      amountSigned: amount === null ? null : -amount,
      balanceAfter,
      status: "payment",
      includeInCashFlow: false,
      warnings: balanceAfter === null ? ["missing loan balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return null;
}

function classifyCreditCardRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "fubon/credit-card-statements") {
    const date = parseDate(firstCell(p, ["posting_date", "consume_date"]));
    const amount = parseAmount(cell(p, "twd_amount"));
    if (amount === null) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "fubon credit-card row has no TWD amount",
      };
    }
    if (
      cell(p, "description") === "本期應繳總額" &&
      cell(p, "card_label") &&
      amount > 0
    ) {
      const accountId = sourceAccount(row, cell(p, "card_label"));
      const position = positionFromRow(
        row,
        "fubon.credit-card-current-due.v1",
        "credit_card",
        accountId,
        "TWD",
        amount,
        "liability",
        parseStatementPeriod(cell(p, "statement_period")),
        {
          label: accountId,
          confidence: "medium",
          warnings: ["derived from statement current due summary"],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
    if (date === null && !firstCell(p, ["card_last_four", "card_number", "card_label"])) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "fubon credit-card statement summary row is not a transaction",
      };
    }

    const explicitAccount = firstCell(p, [
      "card_last_four",
      "card_number",
      "card_label",
    ]);
    const accountId = explicitAccount
      ? sourceAccount(row, explicitAccount)
      : "Fubon credit card";
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "fubon.credit-card-transaction.v1",
        "credit_card",
        accountId,
        "TWD",
        date,
      ),
      description: cell(p, "description"),
      inflow: amount < 0 ? Math.abs(amount) : null,
      outflow: amount > 0 ? amount : null,
      amountSigned: -amount,
      balanceAfter: null,
      status: row.sourceRelativePath.includes("unbilled")
        ? "unbilled"
        : amount < 0
          ? "payment"
          : "posted",
      includeInCashFlow: true,
      warnings: ["transaction row only; no statement liability balance"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/credit-card-statements") {
    const explicitAccount = firstCell(p, ["信用卡號", "信用卡名稱"]);
    const accountId = explicitAccount
      ? sourceAccount(row, explicitAccount)
      : "Yuanta credit card";

    if (cell(p, "新臺幣金額")) {
      const date = parseDate(firstCell(p, ["交易日期", "入帳日期", "消費日期"]));
      const amount = parseAmount(cell(p, "新臺幣金額"));
      if (amount !== null) {
        const transaction: NormalizedTransaction = {
          ...baseTransaction(
            row,
            "yuanta.credit-card-transaction.v2",
            "credit_card",
            accountId,
            "TWD",
            date,
          ),
          accountLabel: firstCell(p, ["信用卡名稱", "信用卡號"]) || accountId,
          description: cell(p, "消費明細"),
          inflow: amount < 0 ? Math.abs(amount) : null,
          outflow: amount > 0 ? amount : null,
          amountSigned: -amount,
          balanceAfter: null,
          status: row.sourceRelativePath.includes("unbilled")
            ? "unbilled"
            : amount < 0
              ? "payment"
              : "posted",
          includeInCashFlow: true,
          warnings: ["transaction row only; no statement liability balance"],
        };
        return { row, transactions: [transaction], positions: [] };
      }
    }

    if (cell(p, "信用額度") || cell(p, "信用額度餘額")) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "credit limit metadata is not an asset/liability",
      };
    }

    if (cell(p, "本期應繳金額")) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason:
          "yuanta credit-card statement due is kept as audit metadata",
      };
    }

    return {
      row,
      transactions: [],
      positions: [],
      auditOnlyReason: "yuanta credit-card metadata or summary row not used in balance",
    };
  }

  return null;
}

function classifyFundRow(row: RawTransactionOccurrence): Classification | null {
  const p = row.rawPayload;
  if (`${row.bank}/${row.product}` !== "yuanta/fund-statements") return null;

  if (cell(p, "基金名稱") && cell(p, "不含息參考市值")) {
    const value = parseAmount(cell(p, "不含息參考市值"));
    if (value !== null) {
      const currency = normalizeCurrency(firstCell(p, ["投資幣別", "幣別"]));
      const fundLabel = cell(p, "基金名稱");
      const position = positionFromRow(
        row,
        "yuanta.fund-position.v1",
        "fund",
        fundAccountId(fundLabel),
        currency,
        value,
        "asset",
        null,
        {
          label: fundLabel,
          confidence: "medium",
          warnings: ["fund market value uses no explicit valuation date"],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (cell(p, "資料類別") === "歷史交易" && cell(p, "投資日期") && cell(p, "投資金額")) {
    const amountText = cell(p, "投資金額");
    const amount = parseAmountToken(amountText);
    const date = parseDate(cell(p, "投資日期"));
    if (amount !== null) {
      const fundLabel = cell(p, "基金名稱");
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-buy.v2",
          "investment",
          fundAccountId(fundLabel),
          currencyFromText(amountText),
          date,
        ),
        accountLabel: fundLabel,
        description: `申購 ${fundLabel}`,
        inflow: null,
        outflow: amount,
        amountSigned: -amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: true,
        warnings: [],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (cell(p, "資料類別") === "歷史交易" && cell(p, "贖回日期") && cell(p, "基金名稱")) {
    const amountText = firstCell(p, ["入帳淨額", "贖回投資金額"]);
    const amount = parseAmountToken(amountText);
    if (amount !== null) {
      const fundLabel = cell(p, "基金名稱");
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-redemption.v2",
          "investment",
          fundAccountId(fundLabel),
          currencyFromText(amountText),
          parseDate(firstCell(p, ["分配日期", "贖回日期"])),
        ),
        accountLabel: fundLabel,
        description: `贖回 ${fundLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: true,
        warnings: [],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (cell(p, "資料類別") === "歷史交易" && cell(p, "入帳日期") && cell(p, "分配金額")) {
    const amountText = cell(p, "分配金額");
    const amount = parseAmountToken(amountText);
    const fundLabel = cell(p, "基金名稱");
    if (amount !== null && fundLabel) {
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-cash-dividend.v2",
          "investment",
          fundAccountId(fundLabel),
          currencyFromText(amountText),
          parseDate(cell(p, "入帳日期")),
        ),
        accountLabel: fundLabel,
        description: `現金配息 ${fundLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "dividend",
        includeInCashFlow: true,
        warnings: [],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (
    cell(p, "資料類別") === "歷史交易" &&
    cell(p, "轉出日期") &&
    cell(p, "轉入日期") &&
    cell(p, "轉出基金") &&
    cell(p, "轉入基金") &&
    cell(p, "轉換投資金額")
  ) {
    const amountText = cell(p, "轉換投資金額");
    const amount = parseAmountToken(amountText);
    if (amount !== null) {
      const fromLabel = cell(p, "轉出基金");
      const toLabel = cell(p, "轉入基金");
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-conversion-in.v2",
          "investment",
          fundAccountId(toLabel),
          currencyFromText(amountText),
          parseDate(cell(p, "轉入日期")),
        ),
        accountLabel: toLabel,
        description: `轉換轉入 ${fromLabel} -> ${toLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund conversion is informational; not included in cash flow"],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  return {
    row,
    transactions: [],
    positions: [],
    auditOnlyReason: "yuanta fund row is metadata, dividend, order, or combined-cell detail",
  };
}

function classifyBrokerageRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row.rawPayload;
  if (`${row.bank}/${row.product}` !== "yuanta/trade-statements") return null;

  if (cell(p, "market_value_twd")) {
    const valueTwd = parseAmount(cell(p, "market_value_twd"));
    if (valueTwd !== null) {
      const currency = normalizeCurrency(cell(p, "currency"), "UNKNOWN");
      const value = parseAmount(cell(p, "market_value_original")) ?? valueTwd;
      const position = positionFromRow(
        row,
        "yuanta.brokerage-holding.v2",
        "brokerage",
        sourceAccount(row, cell(p, "account_number")),
        currency,
        value,
        "asset",
        parseDate(firstCell(p, ["as_of_date", "market_date"])),
        {
          label: [cell(p, "product_code"), cell(p, "product_name")]
            .filter(Boolean)
            .join(" "),
          valueTwd,
          confidence: "high",
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (cell(p, "asset_value_twd")) {
    const value = parseAmount(cell(p, "asset_value_twd"));
    if (value !== null) {
      const position = positionFromRow(
        row,
        "yuanta.brokerage-summary-rollup.v2",
        "brokerage_rollup",
        stableId(["brokerage-rollup", row.sourceRelativePath, cell(p, "asset_name")]),
        "TWD",
        value,
        "informational",
        parseDate(cell(p, "as_of_date")),
        {
          label: [cell(p, "asset_type"), cell(p, "asset_name")]
            .filter(Boolean)
            .join(" "),
          includeInTotals: false,
          confidence: "low",
          warnings: [
            "summary rollup is excluded from totals to avoid double-counting detailed holdings",
          ],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (cell(p, "trade_date") && cell(p, "settlement_amount")) {
    const amount = parseAmount(cell(p, "settlement_amount"));
    const action = cell(p, "action") || cell(p, "trade_type");
    const isInflow = /賣|賣出|sell|配息|股息|息/i.test(action);
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.brokerage-trade.v2",
        "brokerage",
        sourceAccount(row, cell(p, "account_number")),
        normalizeCurrency(
          firstCell(p, ["settlement_currency", "currency"]),
          "UNKNOWN",
        ),
        parseDate(cell(p, "trade_date")),
      ),
      description: [action, cell(p, "product_code"), cell(p, "product_name")]
        .filter(Boolean)
        .join(" "),
      inflow: isInflow ? amount : null,
      outflow: isInflow ? null : amount,
      amountSigned: amount === null ? null : isInflow ? amount : -amount,
      balanceAfter: null,
      status: /配息|股息|息/i.test(action) ? "dividend" : "posted",
      includeInCashFlow: false,
      warnings: isInflow ? [] : ["trade cash-flow direction is not normalized yet"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return {
    row,
    transactions: [],
    positions: [],
    auditOnlyReason: "yuanta trade row is summary label, empty category, or unsupported grid",
  };
}

function classifyRow(row: RawTransactionOccurrence): Classification {
  const classifiers = [
    classifyDepositRow,
    classifyLoanRow,
    classifyCreditCardRow,
    classifyFundRow,
    classifyBrokerageRow,
  ];

  for (const classifier of classifiers) {
    const classified = classifier(row);
    if (classified) return classified;
  }

  return {
    row,
    transactions: [],
    positions: [],
    unsupportedReason: "no parser matched this row shape",
  };
}

function pickLatestSnapshotPositions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
): AssetPosition[] {
  const latest = new Map<string, NormalizedTransaction>();

  for (const transaction of transactions) {
    if (transaction.balanceAfter === null) continue;
    const key = [
      transaction.parserId,
      transaction.accountId,
      transaction.currency,
      transaction.type,
    ].join("|");
    const previous = latest.get(key);
    if (!previous || compareTransactionDate(transaction, previous) > 0) {
      latest.set(key, transaction);
    }
  }

  const positions: AssetPosition[] = [];
  for (const transaction of latest.values()) {
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow || transaction.balanceAfter === null) continue;

    if (transaction.type === "loan") {
      positions.push(
        positionFromRow(
          sourceRow,
          `${transaction.parserId}.snapshot`,
          "loan",
          transaction.accountId,
          transaction.currency,
          transaction.balanceAfter,
          "liability",
          transaction.date,
          {
            label: `${transaction.institution} loan ${transaction.accountId}`,
            confidence: "high",
          },
        ),
      );
      continue;
    }

    positions.push(
      positionFromRow(
        sourceRow,
        `${transaction.parserId}.snapshot`,
        transaction.type === "foreign_deposit" ? "foreign_cash" : "cash",
        transaction.accountId,
        transaction.currency,
        transaction.balanceAfter,
        "asset",
        transaction.date,
        {
          label: `${transaction.institution} ${transaction.accountId}`,
          confidence: "high",
        },
      ),
    );
  }

  return positions;
}

function pickCreditCardLiabilityPositions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
): AssetPosition[] {
  const byAccount = new Map<
    string,
    {
      transaction: NormalizedTransaction;
      value: number;
    }
  >();

  for (const transaction of transactions) {
    if (transaction.type !== "credit_card") continue;
    if (transaction.status !== "unbilled") continue;
    if (transaction.amountSigned === null || transaction.amountSigned >= 0) continue;

    const key = [transaction.accountId, transaction.currency].join("|");
    const previous = byAccount.get(key);
    const value = Math.abs(transaction.amountSigned);
    if (!previous) {
      byAccount.set(key, { transaction, value });
      continue;
    }

    previous.value += value;
    if (compareTransactionDate(transaction, previous.transaction) >= 0) {
      previous.transaction = transaction;
    }
  }

  const positions: AssetPosition[] = [];
  for (const { transaction, value } of byAccount.values()) {
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow || value <= 0) continue;
    positions.push(
      positionFromRow(
        sourceRow,
        "credit-card-unbilled.snapshot",
        "credit_card",
        transaction.accountId,
        transaction.currency,
        value,
        "liability",
        transaction.date,
        {
          label: transaction.accountLabel || transaction.accountId,
          confidence: "medium",
          warnings: ["derived from current unbilled credit-card transactions"],
        },
      ),
    );
  }

  return positions;
}

function compareTransactionDate(
  left: NormalizedTransaction,
  right: NormalizedTransaction,
): number {
  const leftDateTime =
    left.occurredAt ?? (left.date ? `${left.date}T00:00:00` : "");
  const rightDateTime =
    right.occurredAt ?? (right.date ? `${right.date}T00:00:00` : "");
  if (leftDateTime !== rightDateTime) {
    return leftDateTime.localeCompare(rightDateTime);
  }
  return right.sourceRowIndex - left.sourceRowIndex;
}

function reducePositions(positions: AssetPosition[]): AssetPosition[] {
  const byKey = new Map<string, AssetPosition>();

  for (const position of positions) {
    const key = [
      position.parserId,
      position.accountId,
      position.label,
      position.currency,
      position.assetClass,
      position.includeInTotals,
    ].join("|");
    const previous = byKey.get(key);
    if (!previous || comparePositionFreshness(position, previous) >= 0) {
      byKey.set(key, position);
    }
  }

  return [...byKey.values()];
}

function comparePositionFreshness(left: AssetPosition, right: AssetPosition) {
  const leftDateTime =
    left.asOfDateTime ?? (left.asOfDate ? `${left.asOfDate}T00:00:00` : "");
  const rightDateTime =
    right.asOfDateTime ?? (right.asOfDate ? `${right.asOfDate}T00:00:00` : "");
  if (leftDateTime !== rightDateTime) {
    return leftDateTime.localeCompare(rightDateTime);
  }
  return right.sourceRowIndex - left.sourceRowIndex;
}

function rowImportRunId(row: RawTransactionOccurrence): string {
  return row.importRunId ?? `legacy:${row.sourceRelativePath}`;
}

function buildImportRunTimes(
  importRuns: ImportRunRecord[],
  batches: BatchRecord[],
): Map<string, string> {
  const times = new Map<string, string>();

  for (const run of importRuns) {
    times.set(
      run.importRunId,
      run.finishedAt ?? run.startedAt ?? new Date(0).toISOString(),
    );
  }

  for (const batch of batches) {
    if (!batch.importRunId) continue;
    if (times.has(batch.importRunId)) continue;
    if (batch.importedAt) times.set(batch.importRunId, batch.importedAt);
  }

  return times;
}

function importedAtForRow(
  row: RawTransactionOccurrence,
  importRunTimes: Map<string, string>,
): string {
  const runTime = importRunTimes.get(rowImportRunId(row));
  if (runTime) return runTime;
  const importedAt = String(row.importedAt ?? "");
  return importedAt || new Date(0).toISOString();
}

function transactionDeduplicationKey(transaction: NormalizedTransaction): string {
  return stableId([
    "normalized-transaction",
    transaction.institution,
    transaction.product,
    transaction.type,
    transaction.accountId,
    transaction.currency,
    transaction.date,
    transaction.description,
    transaction.status,
    transaction.inflow,
    transaction.outflow,
    transaction.amountSigned,
    transaction.balanceAfter,
  ]);
}

function compareTransactionOccurrenceFreshness(
  left: NormalizedTransaction,
  right: NormalizedTransaction,
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): number {
  const leftRow = sourceRows.get(left.sourceHash);
  const rightRow = sourceRows.get(right.sourceHash);
  const leftImportedAt = leftRow
    ? importedAtForRow(leftRow, importRunTimes)
    : "";
  const rightImportedAt = rightRow
    ? importedAtForRow(rightRow, importRunTimes)
    : "";
  if (leftImportedAt !== rightImportedAt) {
    return leftImportedAt.localeCompare(rightImportedAt);
  }
  if (left.sourceRelativePath !== right.sourceRelativePath) {
    return left.sourceRelativePath.localeCompare(right.sourceRelativePath);
  }
  return left.sourceRowIndex - right.sourceRowIndex;
}

function dedupeTransactions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): {
  transactions: NormalizedTransaction[];
  duplicateCount: number;
} {
  const byKey = new Map<string, NormalizedTransaction>();
  let duplicateCount = 0;

  for (const transaction of transactions) {
    const key = transactionDeduplicationKey(transaction);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, transaction);
      continue;
    }

    duplicateCount += 1;
    if (
      compareTransactionOccurrenceFreshness(
        transaction,
        previous,
        sourceRows,
        importRunTimes,
      ) >= 0
    ) {
      byKey.set(key, transaction);
    }
  }

  return { transactions: [...byKey.values()], duplicateCount };
}

function selectLatestCreditCardUnbilledTransactions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): NormalizedTransaction[] {
  const latestRunByAccount = new Map<
    string,
    { importRunId: string; importedAt: string }
  >();

  for (const transaction of transactions) {
    if (transaction.type !== "credit_card") continue;
    if (transaction.status !== "unbilled") continue;
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow) continue;

    const importRunId = rowImportRunId(sourceRow);
    const importedAt = importedAtForRow(sourceRow, importRunTimes);
    const key = [transaction.accountId, transaction.currency].join("|");
    const previous = latestRunByAccount.get(key);
    if (!previous || previous.importedAt <= importedAt) {
      latestRunByAccount.set(key, { importRunId, importedAt });
    }
  }

  return transactions.filter((transaction) => {
    if (transaction.type !== "credit_card") return true;
    if (transaction.status !== "unbilled") return true;
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow) return false;
    const key = [transaction.accountId, transaction.currency].join("|");
    return latestRunByAccount.get(key)?.importRunId === rowImportRunId(sourceRow);
  });
}

function bucketFromTotals(
  totals: FinancialTotals,
  side: "assets" | "liabilities" | "net",
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const [currency, value] of Object.entries(totals.includedByCurrency)) {
    bucket[currency] = value[side];
  }
  return bucket;
}

function subtractCurrencyBuckets(
  current: CurrencyBucket,
  previous: CurrencyBucket,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const currency of new Set([
    ...Object.keys(current),
    ...Object.keys(previous),
  ])) {
    const value = (current[currency] ?? 0) - (previous[currency] ?? 0);
    if (Math.abs(value) > 0.000001) bucket[currency] = value;
  }
  return bucket;
}

function snapshotAccounts(positions: AssetPosition[]): SnapshotAccountValue[] {
  return positions
    .filter((position) => position.includeInTotals)
    .map((position) => ({
      id: stableId([
        "snapshot-account",
        position.institution,
        position.product,
        position.assetClass,
        position.accountId,
        position.label,
        position.currency,
      ]),
      institution: sourceInstitutionForPosition(position),
      product: position.product,
      assetClass: position.assetClass,
      accountId: position.accountId,
      label: position.label,
      currency: position.currency,
      value: position.value,
      valueSign: position.valueSign,
      includeInTotals: position.includeInTotals,
    }));
}

function signedSnapshotAccountValue(account: SnapshotAccountValue): number {
  if (account.valueSign === "liability") return -Math.abs(account.value);
  return account.value;
}

function totalsFromSnapshotAccounts(
  accounts: SnapshotAccountValue[],
): FinancialTotals {
  const includedByCurrency: FinancialTotals["includedByCurrency"] = {};
  const informationalByCurrency: FinancialTotals["informationalByCurrency"] = {};

  for (const account of accounts) {
    if (!account.includeInTotals) {
      informationalByCurrency[account.currency] =
        (informationalByCurrency[account.currency] ?? 0) + account.value;
      continue;
    }

    includedByCurrency[account.currency] ??= {
      assets: 0,
      liabilities: 0,
      net: 0,
    };
    if (account.valueSign === "liability") {
      includedByCurrency[account.currency].liabilities += account.value;
      includedByCurrency[account.currency].net -= account.value;
    } else {
      includedByCurrency[account.currency].assets += account.value;
      includedByCurrency[account.currency].net += account.value;
    }
  }

  return { includedByCurrency, informationalByCurrency };
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = startDate;
    cursor <= endDate;
    cursor = addDays(cursor, 1)
  ) {
    dates.push(cursor);
  }
  return dates;
}

function buildDailyHistoryFromSnapshots(
  snapshots: AssetSnapshot[],
): DailyAssetHistoryPoint[] {
  if (snapshots.length === 0) return [];

  const sortedSnapshots = [...snapshots].sort((left, right) =>
    left.importedAt.localeCompare(right.importedAt),
  );
  const firstDate = sortedSnapshots
    .map((snapshot) => snapshot.snapshotDate)
    .sort()[0];
  const lastDate = sortedSnapshots
    .map((snapshot) => snapshot.snapshotDate)
    .sort()
    .at(-1);
  if (!firstDate || !lastDate) return [];

  const carriedAccounts = new Map<
    string,
    { account: SnapshotAccountValue; snapshotDate: string; importedAt: string }
  >();
  let previousAccounts = new Map<string, DailyAccountChange>();
  const daily: DailyAssetHistoryPoint[] = [];
  let snapshotIndex = 0;
  let latestAppliedSnapshot = sortedSnapshots[0];

  for (const date of datesBetween(firstDate, lastDate)) {
    while (
      snapshotIndex < sortedSnapshots.length &&
      sortedSnapshots[snapshotIndex].snapshotDate <= date
    ) {
      const snapshot = sortedSnapshots[snapshotIndex];
      latestAppliedSnapshot = snapshot;
      for (const account of snapshot.accounts) {
        carriedAccounts.set(account.id, {
          account,
          snapshotDate: snapshot.snapshotDate,
          importedAt: snapshot.importedAt,
        });
      }
      snapshotIndex += 1;
    }

    const accounts = [...carriedAccounts.values()]
      .sort((left, right) => left.account.id.localeCompare(right.account.id));
    const totals = totalsFromSnapshotAccounts(
      accounts.map((entry) => entry.account),
    );
    const hasPreviousDay = daily.length > 0;
    const accountChanges = accounts.map((entry) => {
      const previous = previousAccounts.get(entry.account.id);
      const signedValue = signedSnapshotAccountValue(entry.account);
      const previousSignedValue = previous?.signedValue ?? null;
      return {
        ...entry.account,
        snapshotDate: entry.snapshotDate,
        signedValue,
        previousSnapshotDate: previous?.snapshotDate ?? null,
        previousValue: previous?.value ?? null,
        previousSignedValue,
        change:
          previousSignedValue === null
            ? hasPreviousDay
              ? signedValue
              : 0
            : signedValue - previousSignedValue,
      };
    });
    const netAssets = bucketFromTotals(totals, "net");
    const previousNetAssets =
      daily.length > 0 ? daily[daily.length - 1].netAssets : {};

    daily.push({
      date,
      importRunId: latestAppliedSnapshot.importRunId,
      importedAt: latestAppliedSnapshot.importedAt,
      assets: bucketFromTotals(totals, "assets"),
      liabilities: bucketFromTotals(totals, "liabilities"),
      netAssets,
      netChange:
        daily.length > 0
          ? subtractCurrencyBuckets(netAssets, previousNetAssets)
          : {},
      positionCount: accounts.length,
      accountChanges,
    });

    previousAccounts = new Map(
      accountChanges.map((change) => [change.id, change]),
    );
  }

  return daily;
}

function buildPositionsForClassifications(
  classifications: Classification[],
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  creditCardTransactions: NormalizedTransaction[] = transactions,
): AssetPosition[] {
  const directPositions = classifications.flatMap((item) => item.positions);
  const snapshotPositions = pickLatestSnapshotPositions(transactions, sourceRows);
  const creditCardPositions = pickCreditCardLiabilityPositions(
    creditCardTransactions,
    sourceRows,
  );
  return reducePositions([
    ...directPositions,
    ...snapshotPositions,
    ...creditCardPositions,
  ]);
}

function buildSnapshotHistory(
  classifications: Classification[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
  generatedAt: string,
): SnapshotHistory {
  const byRun = new Map<string, Classification[]>();
  for (const classification of classifications) {
    const runId = rowImportRunId(classification.row);
    byRun.set(runId, [...(byRun.get(runId) ?? []), classification]);
  }

  const snapshots = [...byRun.entries()]
    .map(([importRunId, runClassifications]) => {
      const runSourceRows = new Map(
        runClassifications.map((classification) => [
          classification.row.sourceHash,
          classification.row,
        ]),
      );
      const { transactions } = dedupeTransactions(
        runClassifications.flatMap((item) => item.transactions),
        runSourceRows,
        importRunTimes,
      );
      const positions = buildPositionsForClassifications(
        runClassifications,
        transactions,
        runSourceRows,
      );
      const importedAt =
        importRunTimes.get(importRunId) ??
        runClassifications
          .map((classification) =>
            importedAtForRow(classification.row, importRunTimes),
          )
          .sort()
          .at(-1) ??
        generatedAt;

      return {
        importRunId,
        importedAt,
        snapshotDate: importedAt.slice(0, 10),
        totals: computeTotals(positions),
        positionCount: positions.length,
        includedPositionCount: positions.filter((position) => position.includeInTotals)
          .length,
        accounts: snapshotAccounts(positions),
      };
    })
    .sort((left, right) => left.importedAt.localeCompare(right.importedAt));

  const daily = buildDailyHistoryFromSnapshots(snapshots);

  return { snapshots, daily };
}

function computeTotals(positions: AssetPosition[]): FinancialTotals {
  const includedByCurrency: FinancialTotals["includedByCurrency"] = {};
  const informationalByCurrency: Record<string, number> = {};

  for (const position of positions) {
    const currency = position.currency || "UNKNOWN";
    if (!position.includeInTotals) {
      informationalByCurrency[currency] =
        (informationalByCurrency[currency] ?? 0) + position.value;
      continue;
    }

    const bucket = (includedByCurrency[currency] ??= {
      assets: 0,
      liabilities: 0,
      net: 0,
    });
    if (position.valueSign === "liability") {
      bucket.liabilities += position.value;
      bucket.net -= position.value;
    } else {
      bucket.assets += position.value;
      bucket.net += position.value;
    }
  }

  return { includedByCurrency, informationalByCurrency };
}

function addCurrencyAmount(
  bucket: CurrencyBucket,
  currency: string,
  value: number,
): CurrencyBucket {
  if (!Number.isFinite(value)) return bucket;
  bucket[currency] = (bucket[currency] ?? 0) + value;
  return bucket;
}

function sumPositionValues(
  positions: AssetPosition[],
  predicate: (position: AssetPosition) => boolean,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const position of positions) {
    if (!predicate(position)) continue;
    addCurrencyAmount(bucket, position.currency, position.value);
  }
  return bucket;
}

function sumTransactionLiability(
  transactions: NormalizedTransaction[],
  predicate: (transaction: NormalizedTransaction) => boolean,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const transaction of transactions) {
    if (!predicate(transaction)) continue;
    const amount = transaction.amountSigned;
    if (amount === null) continue;
    addCurrencyAmount(bucket, transaction.currency, Math.max(-amount, 0));
  }
  return bucket;
}

function sumNetPositionValues(positions: AssetPosition[]): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const position of positions) {
    if (!position.includeInTotals || position.valueSign === "informational") continue;
    const sign = position.valueSign === "liability" ? -1 : 1;
    addCurrencyAmount(bucket, position.currency, position.value * sign);
  }
  return bucket;
}

function mergeCurrencyBuckets(...buckets: CurrencyBucket[]): CurrencyBucket {
  const merged: CurrencyBucket = {};
  for (const bucket of buckets) {
    for (const [currency, value] of Object.entries(bucket)) {
      addCurrencyAmount(merged, currency, value);
    }
  }
  return merged;
}

function dashboardAccountId(
  kind: DashboardAccount["kind"],
  institution: string,
  accountId: string,
): string {
  return stableId(["dashboard-account", kind, institution, accountId]);
}

function metric(label: string, amounts: CurrencyBucket): DashboardMetric {
  return { label, amounts };
}

function textMetric(label: string, value: string): DashboardMetric {
  return { label, value };
}

function sourceInstitutionForPosition(position: AssetPosition): string {
  if (position.assetClass === "brokerage" || position.assetClass === "brokerage_rollup") {
    return "Yuanta brokerage";
  }
  return position.institution;
}

function sourceInstitutionForTransaction(
  transaction: NormalizedTransaction,
): string {
  if (transaction.type === "brokerage") return "Yuanta brokerage";
  return transaction.institution;
}

function accountKindLabel(kind: DashboardAccount["kind"]): string {
  const labels: Record<DashboardAccount["kind"], string> = {
    account: "帳戶",
    credit_card: "信用卡",
    loan: "貸款",
    fund: "基金",
    brokerage: "券商",
  };
  return labels[kind];
}

function buildDashboardView(
  positions: AssetPosition[],
  transactions: NormalizedTransaction[],
  currentTransactions: NormalizedTransaction[] = transactions,
): DashboardView {
  const includedPositions = positions.filter((position) => position.includeInTotals);
  const currentTransactionIds = new Set(
    currentTransactions.map((transaction) => transaction.id),
  );
  const overview: DashboardView["overview"] = {
    assets: {
      totalTwdAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" &&
          position.assetClass === "cash" &&
          position.currency === "TWD",
      ),
      totalForeignAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" && position.assetClass === "foreign_cash",
      ),
      totalInvestmentAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" &&
          ["fund", "brokerage"].includes(position.assetClass),
      ),
    },
    liabilities: {
      unbilledCreditCardAmount: sumTransactionLiability(
        currentTransactions,
        (transaction) =>
          transaction.type === "credit_card" && transaction.status === "unbilled",
      ),
      loanTotalBalance: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "liability" && position.assetClass === "loan",
      ),
    },
    netAssets: sumNetPositionValues(includedPositions),
  };

  const accountMap = new Map<string, DashboardAccount>();
  const transactionIdsByAccount = new Map<string, string[]>();
  const positionIdsByAccount = new Map<string, string[]>();

  function ensureAccount(
    kind: DashboardAccount["kind"],
    institution: string,
    product: string,
    accountId: string,
    label: string,
  ): DashboardAccount {
    const id = dashboardAccountId(kind, institution, accountId);
    const existing = accountMap.get(id);
    if (existing) return existing;

    const account: DashboardAccount = {
      id,
      label,
      kind,
      institution,
      product,
      metrics: [],
      positionIds: [],
      transactionIds: [],
      childAssetIds: [],
    };
    accountMap.set(id, account);
    return account;
  }

  function kindForPosition(position: AssetPosition): DashboardAccount["kind"] | null {
    if (position.assetClass === "cash" || position.assetClass === "foreign_cash") {
      return "account";
    }
    if (position.assetClass === "credit_card") return "credit_card";
    if (position.assetClass === "loan") return "loan";
    if (position.assetClass === "fund") return "fund";
    if (position.assetClass === "brokerage") return "brokerage";
    return null;
  }

  function kindForTransaction(
    transaction: NormalizedTransaction,
  ): DashboardAccount["kind"] | null {
    if (transaction.type === "deposit" || transaction.type === "foreign_deposit") {
      return "account";
    }
    if (transaction.type === "credit_card") return "credit_card";
    if (transaction.type === "loan") return "loan";
    if (transaction.type === "investment") return "fund";
    if (transaction.type === "brokerage") return "brokerage";
    return null;
  }

  for (const position of positions) {
    const kind = kindForPosition(position);
    if (!kind) continue;
    const institution = sourceInstitutionForPosition(position);
    const account = ensureAccount(
      kind,
      institution,
      position.product,
      position.accountId,
      kind === "brokerage"
        ? position.accountId
        : kind === "fund"
          ? position.label
          : position.accountId,
    );
    positionIdsByAccount.set(account.id, [
      ...(positionIdsByAccount.get(account.id) ?? []),
      position.id,
    ]);
    if (kind === "brokerage") {
      account.childAssetIds.push(position.id);
    }
  }

  for (const transaction of transactions) {
    const kind = kindForTransaction(transaction);
    if (!kind) continue;
    const institution = sourceInstitutionForTransaction(transaction);
    const account = ensureAccount(
      kind,
      institution,
      transaction.product,
      transaction.accountId,
      transaction.accountLabel,
    );
    transactionIdsByAccount.set(account.id, [
      ...(transactionIdsByAccount.get(account.id) ?? []),
      transaction.id,
    ]);
  }

  for (const account of accountMap.values()) {
    account.positionIds = [...new Set(positionIdsByAccount.get(account.id) ?? [])];
    account.transactionIds = [
      ...new Set(transactionIdsByAccount.get(account.id) ?? []),
    ];
    account.childAssetIds = [...new Set(account.childAssetIds)];

    const accountPositions = positions.filter((position) =>
      account.positionIds.includes(position.id),
    );
    const accountTransactions = transactions.filter((transaction) =>
      account.transactionIds.includes(transaction.id),
    );
    const accountCurrentTransactions = accountTransactions.filter((transaction) =>
      currentTransactionIds.has(transaction.id),
    );

    if (account.kind === "account") {
      const total = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "asset",
      );
      account.metrics = [
        textMetric(
          "種類",
          accountPositions.some((position) => position.assetClass === "foreign_cash")
            ? "外幣帳戶"
            : "台幣帳戶",
        ),
        metric("總金額", total),
      ];
    } else if (account.kind === "credit_card") {
      const unbilled = sumTransactionLiability(
        accountCurrentTransactions,
        (transaction) => transaction.status === "unbilled",
      );
      const includedUnpaid = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "liability",
      );
      const fallbackUnpaid = sumPositionValues(
        accountPositions,
        (position) => !position.includeInTotals && position.valueSign === "liability",
      );
      account.metrics = [
        metric("未結帳總金額", unbilled),
        metric(
          "未繳總金額",
          Object.keys(includedUnpaid).length > 0 ? includedUnpaid : fallbackUnpaid,
        ),
      ];
    } else if (account.kind === "loan") {
      account.metrics = [
        textMetric("種類", "貸款"),
        metric(
          "貸款餘額",
          sumPositionValues(
            accountPositions,
            (position) => position.valueSign === "liability",
          ),
        ),
      ];
    } else if (account.kind === "fund") {
      const fundValue = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "asset",
      );
      if (Object.keys(fundValue).length === 0) {
        for (const transaction of accountTransactions) {
          if (transaction.currency && transaction.currency !== "UNKNOWN") {
            fundValue[transaction.currency] ??= 0;
          }
        }
      }
      account.metrics = [
        metric("淨值資產", fundValue),
      ];
    } else if (account.kind === "brokerage") {
      account.metrics = [
        textMetric("種類", "券商資產"),
        metric(
          "淨值總資產",
          sumPositionValues(
            accountPositions,
            (position) => position.includeInTotals && position.valueSign === "asset",
          ),
        ),
      ];
    }
  }

  const sectionLabels: Record<DashboardAccount["kind"], string> = {
    account: "帳戶",
    credit_card: "信用卡",
    loan: "貸款",
    fund: "基金",
    brokerage: "券商帳戶",
  };
  const institutionOrder = ["Fubon", "Yuanta", "Cathay", "Yuanta brokerage"];
  const sectionOrder: DashboardAccount["kind"][] = [
    "account",
    "credit_card",
    "loan",
    "fund",
    "brokerage",
  ];
  const institutions = [...new Set([...accountMap.values()].map((item) => item.institution))]
    .sort((a, b) => {
      const left = institutionOrder.indexOf(a);
      const right = institutionOrder.indexOf(b);
      if (left !== -1 || right !== -1) {
        return (left === -1 ? 999 : left) - (right === -1 ? 999 : right);
      }
      return a.localeCompare(b);
    })
    .map((institution) => {
      const accounts = [...accountMap.values()]
        .filter((account) => account.institution === institution)
        .sort(
          (a, b) =>
            sectionOrder.indexOf(a.kind) - sectionOrder.indexOf(b.kind) ||
            a.label.localeCompare(b.label),
        );
      return {
        id: stableId(["dashboard-institution", institution]),
        label: institution,
        groups: sectionOrder
          .map((kind) => ({
            kind,
            label: sectionLabels[kind],
            accounts: accounts.filter((account) => account.kind === kind),
          }))
          .filter((group) => group.accounts.length > 0),
      };
    });

  return { overview, institutions };
}

function buildQualityIssues(model: Omit<FinancialModel, "quality">): QualityIssue[] {
  const issues: QualityIssue[] = [];

  const seenSourceHashes = new Set<string>();
  for (const transaction of model.normalizedTransactions) {
    if (seenSourceHashes.has(transaction.sourceHash)) {
      issues.push({
        level: "warn",
        code: "transaction-source-reused",
        message: "Multiple normalized transactions share the same source row.",
        sourceRelativePath: transaction.sourceRelativePath,
        sourceRowIndex: transaction.sourceRowIndex,
      });
    }
    seenSourceHashes.add(transaction.sourceHash);
  }

  for (const position of model.assetPositions) {
    if (!Number.isFinite(position.value)) {
      issues.push({
        level: "error",
        code: "position-invalid-value",
        message: "Asset position has a non-finite value.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
    if (!position.currency) {
      issues.push({
        level: "error",
        code: "position-missing-currency",
        message: "Asset position is missing currency.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
    if (position.includeInTotals && position.valueSign === "informational") {
      issues.push({
        level: "error",
        code: "informational-position-included",
        message: "Informational position must not be included in totals.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
  }

  for (const [key, coverage] of Object.entries(model.parserCoverage)) {
    if (coverage.parsedRows === 0) {
      issues.push({
        level: "warn",
        code: "source-unparsed",
        message: `No rows were parsed for ${key}.`,
      });
    } else if (coverage.unsupportedRows > coverage.rows * 0.1) {
      issues.push({
        level: "warn",
        code: "source-low-coverage",
        message: `${key} has more than 10% truly unsupported rows.`,
      });
    }
  }

  return issues;
}

function statusForIssues(issues: QualityIssue[]): FinancialModel["quality"]["status"] {
  if (issues.some((issue) => issue.level === "error")) return "fail";
  if (issues.some((issue) => issue.level === "warn")) return "warn";
  return "pass";
}

function buildCoverage(
  rows: RawTransactionOccurrence[],
  classifications: Classification[],
): FinancialModel["parserCoverage"] {
  const coverage: FinancialModel["parserCoverage"] = {};

  for (const row of rows) {
    const key = `${row.bank}/${row.product}`;
    coverage[key] ??= {
      rows: 0,
      parsedRows: 0,
      auditOnlyRows: 0,
      unsupportedRows: 0,
      transactions: 0,
      positions: 0,
    };
    coverage[key].rows += 1;
  }

  for (const classification of classifications) {
    const key = `${classification.row.bank}/${classification.row.product}`;
    const bucket = coverage[key];
    const parsed =
      classification.transactions.length > 0 || classification.positions.length > 0;
    if (parsed) bucket.parsedRows += 1;
    if (classification.auditOnlyReason) bucket.auditOnlyRows += 1;
    if (classification.unsupportedReason) bucket.unsupportedRows += 1;
    bucket.transactions += classification.transactions.length;
    bucket.positions += classification.positions.length;
  }

  return coverage;
}

async function buildFinancialModel(input: Input): Promise<FinancialModel> {
  const ledgerDir = resolve(input.ledgerDir);
  const ledgerRecords = await readLedgerRecords(ledgerDir);
  const { batches, importRuns } = ledgerRecords;
  const importRunTimes = buildImportRunTimes(importRuns, batches);
  const sourceAccountHints = await buildSourceAccountHints(batches);
  const rawRows = ledgerRecords.rawRows.map((row) => ({
    ...row,
    sourceAccountHint: sourceAccountHints.get(row.sourceRelativePath),
  }));

  const rows = input.includeDuplicates
    ? rawRows
    : rawRows.filter((row) => row.dedupeStatus !== "duplicate");
  const sourceRows = new Map(rows.map((row) => [row.sourceHash, row]));
  const classifications = rows.map(classifyRow);
  const rawTransactions = classifications.flatMap((item) => item.transactions);
  const { transactions, duplicateCount: duplicateNormalizedTransactions } =
    dedupeTransactions(rawTransactions, sourceRows, importRunTimes);
  const generatedAt = new Date().toISOString();
  const snapshotHistory = buildSnapshotHistory(
    classifications,
    sourceRows,
    importRunTimes,
    generatedAt,
  );
  const currentTransactions = selectLatestCreditCardUnbilledTransactions(
    transactions,
    sourceRows,
    importRunTimes,
  );
  const assetPositions = buildPositionsForClassifications(
    classifications,
    transactions,
    sourceRows,
    currentTransactions,
  );
  const unsupportedRows = classifications
    .filter((item) => item.unsupportedReason)
    .map((item) => ({
      bank: item.row.bank,
      product: item.row.product,
      sourceRelativePath: item.row.sourceRelativePath,
      sourceRowIndex: item.row.sourceRowIndex,
      reason: item.unsupportedReason ?? "unsupported",
    }));
  const auditOnlyRows = classifications
    .filter((item) => item.auditOnlyReason)
    .map((item) => ({
      bank: item.row.bank,
      product: item.row.product,
      sourceRelativePath: item.row.sourceRelativePath,
      sourceRowIndex: item.row.sourceRowIndex,
      reason: item.auditOnlyReason ?? "audit only",
    }));
  const parserCoverage = buildCoverage(rows, classifications);
  const dashboard = buildDashboardView(
    assetPositions,
    transactions,
    currentTransactions,
  );
  const baseModel = {
    schemaVersion: "financial-model.v1" as const,
    generatedAt,
    sourceLedgerDir: ledgerDir,
    sourceLedgerStore: ledgerRecords.source,
    counts: {
      rawRows: rawRows.length,
      uniqueRows: rawRows.filter((row) => row.dedupeStatus !== "duplicate").length,
      duplicateRows: rawRows.filter((row) => row.dedupeStatus === "duplicate").length,
      normalizedTransactions: transactions.length,
      assetPositions: assetPositions.length,
      includedPositions: assetPositions.filter((position) => position.includeInTotals)
        .length,
      duplicateNormalizedTransactions,
      assetSnapshots: snapshotHistory.snapshots.length,
      auditOnlyRows: auditOnlyRows.length,
      unsupportedRows: unsupportedRows.length,
    },
    totals: computeTotals(assetPositions),
    dashboard,
    parserCoverage,
    assetPositions,
    normalizedTransactions: transactions,
    snapshotHistory,
    unsupportedRows,
    auditOnlyRows,
    sourceBatches: {
      count: batches.length,
      layoutStrategies: batches.reduce<Record<string, number>>((acc, batch) => {
        const key = batch.csvLayout?.strategy ?? "missing";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
  const issues = buildQualityIssues(baseModel);

  return {
    ...baseModel,
    quality: {
      status: statusForIssues(issues),
      issues,
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function currencyBucketText(bucket: CurrencyBucket | undefined): string {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => {
      const order = ["TWD", "USD", "JPY", "UNKNOWN"];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.localeCompare(right);
    });

  if (entries.length === 0) return "-";
  return entries.map(([currency, value]) => money(value, currency)).join(" / ");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}


type LedgerLensGroup = "asset" | "liability" | "investment";

type LedgerLensAccount = {
  id: string;
  label: string;
  institution: string;
  kind: DashboardAccount["kind"];
  kindLabel: string;
  group: LedgerLensGroup;
  source: string;
  amounts: CurrencyBucket;
  positionIds: string[];
  transactionIds: string[];
};

const dashboardCurrencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];

function sortCurrencyCode(left: string, right: string): number {
  const leftIndex = dashboardCurrencyOrder.indexOf(left);
  const rightIndex = dashboardCurrencyOrder.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  }
  return left.localeCompare(right);
}

function scaledCurrencyBucket(bucket: CurrencyBucket | undefined, scale: number): CurrencyBucket {
  const scaled: CurrencyBucket = {};
  for (const [currency, value] of Object.entries(bucket ?? {})) {
    if (Number.isFinite(value)) scaled[currency] = value * scale;
  }
  return scaled;
}

function hasCurrencyAmounts(bucket: CurrencyBucket | undefined): boolean {
  return Object.values(bucket ?? {}).some((value) => Number.isFinite(value));
}

function formatDashboardMoney(value: number, currency: string): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(normalized));
  return `${normalized < 0 ? "-" : ""}${currency} ${formatted}`;
}

function currencyBucketLines(bucket: CurrencyBucket | undefined): string[] {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => sortCurrencyCode(left, right));
  if (entries.length === 0) return ["-"];
  return entries.map(([currency, value]) => formatDashboardMoney(value, currency));
}

function currencyBucketSign(bucket: CurrencyBucket | undefined): "positive" | "negative" | "neutral" {
  const firstValue = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value) && value !== 0)
    .sort(([left], [right]) => sortCurrencyCode(left, right))[0]?.[1];
  if (firstValue === undefined) return "neutral";
  return firstValue < 0 ? "negative" : "positive";
}

function latestDashboardDate(model: FinancialModel): string {
  const dates = [
    ...model.assetPositions.map((position) => position.asOfDate),
    ...model.normalizedTransactions.map((transaction) => transaction.date),
    model.generatedAt.slice(0, 10),
  ].filter((value): value is string => Boolean(value));
  return dates.sort().at(-1) ?? model.generatedAt.slice(0, 10);
}

function dailyAccountChangeSummary(changes: DailyAccountChange[]): string {
  const changed = changes
    .filter((change) => Math.abs(change.change) > 0.000001)
    .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
    .slice(0, 4);
  if (changed.length === 0) return "No account changes";
  return changed
    .map(
      (change) =>
        `${change.institution} ${change.label} ${money(
          change.change,
          change.currency,
        )}`,
    )
    .join("\n");
}

function ledgerLensGroup(account: DashboardAccount): LedgerLensGroup {
  if (account.kind === "credit_card" || account.kind === "loan") return "liability";
  if (account.kind === "fund" || account.kind === "brokerage") return "investment";
  return "asset";
}

function accountSourceLabel(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
  transactionsById: Map<string, NormalizedTransaction>,
): string {
  const source =
    account.positionIds.map((id) => positionsById.get(id)?.sourceRelativePath).find(Boolean) ??
    account.transactionIds.map((id) => transactionsById.get(id)?.sourceRelativePath).find(Boolean);
  if (!source) return account.product;
  const [folder] = source.split("/");
  return folder || source;
}

function signedAccountAmounts(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const id of account.positionIds) {
    const position = positionsById.get(id);
    if (!position || !position.includeInTotals || position.valueSign === "informational") continue;
    const sign = position.valueSign === "liability" ? -1 : 1;
    addCurrencyAmount(bucket, position.currency, position.value * sign);
  }
  if (hasCurrencyAmounts(bucket)) return bucket;

  const fallbackMetric = account.metrics.find((item) => hasCurrencyAmounts(item.amounts));
  const fallbackScale = ledgerLensGroup(account) === "liability" ? -1 : 1;
  return scaledCurrencyBucket(fallbackMetric?.amounts, fallbackScale);
}

function buildLedgerLensAccounts(model: FinancialModel): LedgerLensAccount[] {
  const positionsById = new Map(model.assetPositions.map((position) => [position.id, position]));
  const transactionsById = new Map(
    model.normalizedTransactions.map((transaction) => [transaction.id, transaction]),
  );
  return model.dashboard.institutions.flatMap((institution) =>
    institution.groups.flatMap((group) =>
      group.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        institution: institution.label,
        kind: account.kind,
        kindLabel: accountKindLabel(account.kind),
        group: ledgerLensGroup(account),
        source: accountSourceLabel(account, positionsById, transactionsById),
        amounts: signedAccountAmounts(account, positionsById),
        positionIds: account.positionIds,
        transactionIds: account.transactionIds,
      })),
    ),
  );
}

function renderSummaryMetric(input: {
  label: string;
  amounts: CurrencyBucket;
  primary?: boolean;
  breakdown: string[];
}): string {
  const [primaryLine, ...secondaryLines] = currencyBucketLines(input.amounts);
  return `
        <div class="metric${input.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(input.label)}</span>
          <div class="metric-value">
            <strong><span data-sensitive>${escapeHtml(primaryLine)}</span></strong>
            ${secondaryLines.length > 0 ? `<small data-sensitive>${escapeHtml(secondaryLines.join(" / "))}</small>` : ""}
          </div>
          ${
            input.breakdown.length > 0
              ? `<div class="metric-breakdown">${input.breakdown
                  .map((item) => `<span>${escapeHtml(item)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`;
}

function renderPlainSummaryMetric(input: {
  label: string;
  value: string;
  primary?: boolean;
  breakdown: string[];
}): string {
  return `
        <div class="metric${input.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(input.label)}</span>
          <div class="metric-value">
            <strong>${escapeHtml(input.value)}</strong>
          </div>
          ${
            input.breakdown.length > 0
              ? `<div class="metric-breakdown">${input.breakdown
                  .map((item) => `<span>${escapeHtml(item)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`;
}

function renderLedgerLensStyles(includeSources = false): string {
  return `
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #f7f7f7;
      --surface-warm: #eeeeee;
      --fg: #111111;
      --fg-2: #3a3a3a;
      --muted: #707070;
      --border: #d9d9d9;
      --border-soft: #eeeeee;
      --accent: #111111;
      --accent-on: #ffffff;
      --success: #168a46;
      --warn: #b7791f;
      --danger: #c53030;
      --font-display: Inter, system-ui, sans-serif;
      --font-body: Inter, system-ui, sans-serif;
      --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
      --text-xs: 12px;
      --text-sm: 14px;
      --text-base: 16px;
      --text-lg: 18px;
      --text-xl: 24px;
      --text-2xl: 36px;
      --text-3xl: 54px;
      --leading-body: 1.52;
      --leading-tight: 1.06;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-12: 48px;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-pill: 9999px;
      --elev-ring: 0 0 0 1px var(--border);
      --elev-raised: 0 16px 40px rgba(0, 0, 0, 0.10);
      --focus-ring: 0 0 0 3px rgba(17, 17, 17, 0.18);
      --motion-fast: 150ms;
      --ease-standard: cubic-bezier(0.2, 0, 0, 1);
      --container-gutter-desktop: 36px;
      --container-gutter-phone: 16px;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--bg); }
    body {
      min-width: 0;
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font: var(--text-base)/var(--leading-body) var(--font-body);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body.modal-open { overflow: hidden; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    svg { display: block; stroke-width: 1.8; }
    h1 {
      max-width: 760px;
      margin: var(--space-1) 0 0;
      font: 650 clamp(38px, 5.2vw, var(--text-3xl))/var(--leading-tight) var(--font-display);
      letter-spacing: 0;
      text-wrap: balance;
    }
    .app {
      min-width: 0;
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .main {
      min-width: 0;
      padding: var(--space-6) clamp(var(--container-gutter-phone), 4vw, var(--container-gutter-desktop)) var(--space-12);
      display: grid;
      gap: var(--space-5);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .visibility-toggle {
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 var(--space-4);
      background: var(--surface);
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      cursor: pointer;
      user-select: none;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .visibility-toggle:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .visibility-toggle input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
    }
    .visibility-toggle:has(input:focus-visible) {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    html[data-values-visible="false"] [data-sensitive] {
      color: var(--muted);
    }
    .label, .eyebrow, .table th, .chip, .metric-label {
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .btn, .segment button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .btn {
      min-height: 42px;
      padding: 0 var(--space-4);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      text-decoration: none;
    }
    .btn:hover, .segment button:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .btn:focus-visible, .segment button:focus-visible, .account-main:focus-visible, .tx-chip:focus-visible, .asset-chip:focus-visible, input:focus-visible, select:focus-visible, .sort-button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-3);
      align-items: stretch;
    }
    .metric {
      min-width: 0;
      min-height: 142px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      padding: var(--space-4);
      display: grid;
      align-content: space-between;
      gap: var(--space-2);
    }
    .metric.primary { border-color: var(--fg); }
    .metric-value { display: grid; gap: 2px; }
    .metric strong {
      display: block;
      font: 700 clamp(22px, 2.4vw, 32px)/1.05 var(--font-display);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .metric-value small {
      color: var(--fg-2);
      font: 650 var(--text-sm)/1.2 var(--font-mono);
      letter-spacing: 0.01em;
    }
    .metric-breakdown {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: var(--space-1);
    }
    .metric-breakdown span, .chip {
      min-height: 22px;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--bg);
      color: var(--fg-2);
      line-height: 1.2;
      white-space: nowrap;
    }
    .workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      overflow: hidden;
    }
    .panel-head {
      min-height: 64px;
      padding: var(--space-5);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .panel-title { display: grid; gap: var(--space-1); }
    .panel-title strong { font: 650 var(--text-xl)/1.08 var(--font-display); }
    .panel-body { padding: var(--space-5); }
    .toolbar { display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
    .segment {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 14%);
      overflow: auto;
    }
    .segment button {
      min-height: 34px;
      padding: 0 var(--space-3);
      white-space: nowrap;
      font-size: var(--text-sm);
    }
    .segment button[aria-pressed="true"] {
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      box-shadow: var(--elev-ring);
    }
    .search { position: relative; min-width: 0; }
    .search svg {
      position: absolute;
      left: var(--space-4);
      top: 50%;
      width: 17px;
      height: 17px;
      color: var(--muted);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: 0 var(--space-4) 0 44px;
      outline: none;
    }
    .account-list, .source-list { display: grid; gap: var(--space-2); }
    .account-row {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: var(--space-4);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "main amount" "actions amount";
      gap: var(--space-3);
      text-align: left;
      transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
    }
    .account-row:hover { transform: translateY(-1px); border-color: var(--accent); }
    .account-row[data-selected="true"] {
      border-color: var(--accent);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 28%);
    }
    .account-row[data-selected="true"] .account-name strong {
      text-decoration: underline;
      text-underline-offset: 4px;
      text-decoration-thickness: 1px;
    }
    .account-main {
      grid-area: main;
      min-width: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      padding: 0;
      text-align: left;
      cursor: pointer;
    }
    .account-name { min-width: 0; display: grid; gap: var(--space-2); }
    .account-name strong {
      overflow-wrap: anywhere;
      font: 650 var(--text-base)/1.18 var(--font-display);
    }
    .account-line, .muted {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .amount {
      grid-area: amount;
      align-self: start;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: normal;
      text-align: right;
    }
    .amount span { display: block; }
    .positive { color: var(--success); }
    .negative { color: var(--danger); }
    .neutral { color: var(--fg-2); }
    .chip-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .account-actions { grid-area: actions; }
    .chip {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-xs);
      font-weight: 700;
      text-transform: uppercase;
    }
    .chip.asset { color: var(--success); }
    .chip.liability { color: var(--danger); }
    .chip.investment, .chip.review { color: var(--warn); }
    .chip.ready { color: var(--success); }
    .chip.unsupported, .chip.fail { color: var(--danger); }
    .tx-chip, .asset-chip {
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
    }
    .tx-chip:hover, .asset-chip:hover {
      border-color: var(--accent);
      color: var(--fg);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 45%);
    }
    .table-wrap {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      overflow: auto;
    }
    .table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    .table th, .table td {
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border-soft);
      text-align: left;
      vertical-align: middle;
    }
    .table th { background: color-mix(in oklab, var(--surface), var(--surface-warm) 16%); }
    .table tbody tr:hover td { background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%); }
    .table tr:last-child td { border-bottom: 0; }
    .table .num {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .sort-button {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      padding: 0;
    }
    .sort-button:hover {
      color: var(--fg);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .sort-mark {
      min-width: 1.2em;
      color: var(--muted);
      font-family: var(--font-mono);
      line-height: 1;
    }
    .modal-layer {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: var(--space-5);
    }
    .modal-layer[hidden] { display: none; }
    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(17, 17, 17, 0.28);
      backdrop-filter: blur(3px);
    }
    .tx-window {
      position: relative;
      z-index: 1;
      width: min(960px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg);
      box-shadow: var(--elev-raised);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      overflow: hidden;
    }
    .tx-window.has-tools { grid-template-rows: auto auto auto minmax(0, 1fr); }
    .tx-window-head, .tx-window-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-5);
      border-bottom: 1px solid var(--border-soft);
    }
    .tx-window-title {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }
    .tx-window-title strong {
      font: 700 var(--text-xl)/1.12 var(--font-display);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .tx-close {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      font-size: 24px;
      line-height: 1;
    }
    .tx-close:hover, .tx-close:focus-visible {
      border-color: var(--accent);
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .tx-window-meta {
      justify-content: flex-start;
      flex-wrap: wrap;
      padding-top: var(--space-3);
      padding-bottom: var(--space-3);
    }
    .tx-window .table-wrap {
      border: 0;
      border-radius: 0;
      min-height: 0;
      max-height: 100%;
    }
    .tx-table-tools {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px auto;
      gap: var(--space-3);
      align-items: end;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border-soft);
      background: color-mix(in oklab, var(--surface), white 18%);
    }
    .tx-filter, .field {
      display: grid;
      gap: var(--space-2);
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-body);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tx-filter input, .tx-filter select, .field input, .field select {
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--fg);
      font: 500 var(--text-sm)/1.2 var(--font-body);
      letter-spacing: 0;
      text-transform: none;
      padding: 0 var(--space-3);
      outline: none;
    }
    .tx-filter-count, .result-count {
      justify-self: end;
      padding-bottom: 11px;
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .tx-table-empty td {
      color: var(--muted);
      text-align: center;
      padding: var(--space-8);
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      color: var(--muted);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%);
    }
    .empty strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--fg);
      font: 650 var(--text-base)/1.2 var(--font-display);
    }
    ${
      includeSources
        ? `
    .sources {
      display: grid;
      grid-template-columns: minmax(300px, 0.85fr) minmax(0, 1.15fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel-tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(150px, auto) auto;
      gap: var(--space-3);
      align-items: end;
      margin-bottom: var(--space-4);
    }
    .source-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      background: var(--bg);
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(96px, auto);
      gap: var(--space-3);
      align-items: center;
    }
    .source-card strong {
      display: block;
      overflow-wrap: anywhere;
    }
    .source-card span {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .source-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-2);
      align-items: center;
    }
    .progress {
      height: 6px;
      margin-top: var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--surface-warm);
      overflow: hidden;
    }
    .progress span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }
    .table td {
      color: var(--fg-2);
      font-size: var(--text-sm);
    }
    .table td strong {
      display: block;
      color: var(--fg);
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .table-meta {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: var(--text-xs);
    }`
        : ""
    }
    @media (max-width: 820px) {
      .sources { grid-template-columns: 1fr; }
      .panel-tools { grid-template-columns: 1fr; }
      .result-count { justify-self: start; padding-bottom: 0; }
    }
    @media (max-width: 720px) {
      .main { padding: var(--space-4) var(--container-gutter-phone) var(--space-8); }
      .topbar {
        align-items: stretch;
        flex-direction: column;
        display: flex;
      }
      .actions, .btn { width: 100%; }
      .summary-strip {
        grid-template-columns: 1fr;
      }
      .metric { min-height: 128px; }
      .account-row {
        grid-template-columns: 1fr;
        grid-template-areas: "main" "amount" "actions";
      }
      .amount { text-align: left; }
      .modal-layer { padding: var(--space-3); }
      .tx-window { max-height: calc(100vh - 24px); }
      .tx-window-head { align-items: flex-start; }
      .tx-window-head, .tx-window-meta, .tx-table-tools {
        padding-left: var(--space-4);
        padding-right: var(--space-4);
      }
      .tx-table-tools { grid-template-columns: 1fr; }
      .tx-filter-count { justify-self: start; padding-bottom: 0; }
      .table th, .table td { padding: var(--space-3); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }`;
}

function renderLedgerLensDashboard(model: FinancialModel): string {
  const accounts = buildLedgerLensAccounts(model);
  const snapshotDate = latestDashboardDate(model);
  const summaryCounts = {
    all: accounts.length,
    asset: accounts.filter((account) => account.group === "asset").length,
    liability: accounts.filter((account) => account.group === "liability").length,
    investment: accounts.filter((account) => account.group === "investment").length,
  };
  const overview = model.dashboard.overview;
  const overviewHtml = [
    renderSummaryMetric({
      label: "Net position",
      amounts: overview.netAssets,
      primary: true,
      breakdown: [
        `${summaryCounts.all} accounts`,
        `${summaryCounts.asset} asset`,
        `${summaryCounts.liability} liability`,
        `${summaryCounts.investment} investment`,
      ],
    }),
    renderSummaryMetric({
      label: "Asset value",
      amounts: mergeCurrencyBuckets(
        overview.assets.totalTwdAssets,
        overview.assets.totalForeignAssets,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "account").length} bank accounts`,
        `${accounts.filter((account) => account.amounts.USD || account.amounts.JPY).length} foreign deposits`,
      ],
    }),
    renderSummaryMetric({
      label: "Liabilities",
      amounts: scaledCurrencyBucket(
        mergeCurrencyBuckets(
          overview.liabilities.unbilledCreditCardAmount,
          overview.liabilities.loanTotalBalance,
        ),
        -1,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "loan").length} loans`,
        `${accounts.filter((account) => account.kind === "credit_card").length} credit cards`,
      ],
    }),
    renderSummaryMetric({
      label: "Investments",
      amounts: overview.assets.totalInvestmentAssets,
      breakdown: [
        `${accounts.filter((account) => account.kind === "fund").length} funds`,
        `${accounts.filter((account) => account.kind === "brokerage").length} brokerage`,
      ],
    }),
  ].join("");
  const historyRows = model.snapshotHistory.daily
    .slice(-14)
    .reverse()
    .map(
      (point) => `
        <tr>
          <td>${escapeHtml(point.date)}</td>
          <td>${escapeHtml(currencyBucketText(point.netAssets))}</td>
          <td>${escapeHtml(currencyBucketText(point.netChange))}</td>
          <td>${escapeHtml(currencyBucketText(point.assets))}</td>
          <td>${escapeHtml(currencyBucketText(point.liabilities))}</td>
          <td>${escapeHtml(dailyAccountChangeSummary(point.accountChanges)).replace(/\n/g, "<br>")}</td>
          <td class="num">${point.positionCount}</td>
        </tr>`,
    )
    .join("");
  const firstAccountId = accounts[0]?.id ?? null;
  const payload = {
    accounts,
    positions: model.assetPositions,
    transactions: model.normalizedTransactions,
    snapshotHistory: model.snapshotHistory,
    firstAccountId,
  };

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LedgerLens Accounts</title>
  <style>${renderLedgerLensStyles()}</style>
</head>
<body>
  <div class="app">
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Snapshot ${escapeHtml(snapshotDate)}</div>
          <h1>Account overview</h1>
        </div>
        <div class="actions">
          <label class="visibility-toggle">
            <input id="value-visibility" type="checkbox" checked />
            <span id="value-visibility-label">Values visible</span>
          </label>
        </div>
      </header>

      <section class="summary-strip" aria-label="Portfolio value and account counts">
        ${overviewHtml}
      </section>

      <section class="panel history-panel" aria-labelledby="history-title">
        <div class="panel-head">
          <div class="panel-title">
            <span class="label">Snapshot history</span>
            <strong id="history-title">Daily asset changes</strong>
          </div>
          <span class="result-count">${model.snapshotHistory.snapshots.length} snapshots</span>
        </div>
        <div class="panel-body">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Net assets</th>
                  <th>Daily change</th>
                  <th>Assets</th>
                  <th>Liabilities</th>
                  <th>Account changes</th>
                  <th class="num">Positions</th>
                </tr>
              </thead>
              <tbody>${
                historyRows ||
                '<tr><td colspan="7">No snapshot history yet.</td></tr>'
              }</tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="workbench" id="accounts">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Account list</span>
              <strong id="account-count" role="status" aria-live="polite">0 accounts</strong>
            </div>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="segment" aria-label="Account type filter">
                <button type="button" data-filter="all" aria-pressed="true">All</button>
                <button type="button" data-filter="asset" aria-pressed="false">Assets</button>
                <button type="button" data-filter="liability" aria-pressed="false">Liabilities</button>
                <button type="button" data-filter="investment" aria-pressed="false">Investments</button>
              </div>
              <label class="search" aria-label="Search accounts">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7"></circle>
                  <path d="M20 20l-3.5-3.5"></path>
                </svg>
                <input id="account-search" type="search" placeholder="Search account, bank, type" />
              </label>
            </div>
            <div class="account-list" id="account-list" role="list"></div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <div class="modal-layer" id="tx-modal" hidden>
    <div class="modal-backdrop" data-close-modal></div>
    <section class="tx-window has-tools" role="dialog" aria-modal="true" aria-labelledby="tx-modal-title" aria-describedby="tx-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Transactions</span>
          <strong id="tx-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="tx-modal-close" aria-label="Close transactions">&times;</button>
      </header>
      <div class="tx-window-meta" id="tx-modal-meta"></div>
      <div class="tx-table-tools" aria-label="Transaction table controls">
        <label class="tx-filter">
          <span>Filter</span>
          <input id="tx-table-filter" type="search" placeholder="Search date, status, description, source" />
        </label>
        <label class="tx-filter">
          <span>Status</span>
          <select id="tx-status-filter"><option value="all">All status</option></select>
        </label>
        <span class="tx-filter-count" id="tx-filter-count" role="status" aria-live="polite">0 rows</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Transactions for the selected account</caption>
          <thead>
            <tr>
              <th scope="col" data-sort-column="date" aria-sort="descending"><button class="sort-button" type="button" data-tx-sort="date">Date <span class="sort-mark" aria-hidden="true">↓</span></button></th>
              <th scope="col" data-sort-column="status"><button class="sort-button" type="button" data-tx-sort="status">Status <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="description"><button class="sort-button" type="button" data-tx-sort="description">Description <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="source"><button class="sort-button" type="button" data-tx-sort="source">Source <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" class="num" data-sort-column="amount"><button class="sort-button" type="button" data-tx-sort="amount">Amount <span class="sort-mark" aria-hidden="true"></span></button></th>
            </tr>
          </thead>
          <tbody id="tx-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="modal-layer" id="asset-modal" hidden>
    <div class="modal-backdrop" data-close-asset-modal></div>
    <section class="tx-window" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title" aria-describedby="asset-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Assets</span>
          <strong id="asset-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="asset-modal-close" aria-label="Close assets">&times;</button>
      </header>
      <div class="tx-window-meta" id="asset-modal-meta"></div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Assets and current values for the selected account</caption>
          <thead><tr><th scope="col">Asset</th><th scope="col">Type</th><th scope="col">As of</th><th scope="col" class="num">Current value</th></tr></thead>
          <tbody id="asset-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <script>
    const payload = ${jsonForScript(payload)};
    const accounts = payload.accounts;
    const positionsById = Object.fromEntries(payload.positions.map(function(position) { return [position.id, position]; }));
    const transactionsById = Object.fromEntries(payload.transactions.map(function(transaction) { return [transaction.id, transaction]; }));
    const accountList = document.getElementById("account-list");
    const accountCount = document.getElementById("account-count");
    const accountSearch = document.getElementById("account-search");
    const valueVisibility = document.getElementById("value-visibility");
    const valueVisibilityLabel = document.getElementById("value-visibility-label");
    const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
    const txModal = document.getElementById("tx-modal");
    const txModalTitle = document.getElementById("tx-modal-title");
    const txModalMeta = document.getElementById("tx-modal-meta");
    const txModalRows = document.getElementById("tx-modal-rows");
    const txTableFilter = document.getElementById("tx-table-filter");
    const txStatusFilter = document.getElementById("tx-status-filter");
    const txFilterCount = document.getElementById("tx-filter-count");
    const txSortButtons = Array.from(document.querySelectorAll("[data-tx-sort]"));
    const txSortHeaders = Array.from(document.querySelectorAll("[data-sort-column]"));
    const txModalClose = document.getElementById("tx-modal-close");
    const assetModal = document.getElementById("asset-modal");
    const assetModalTitle = document.getElementById("asset-modal-title");
    const assetModalMeta = document.getElementById("asset-modal-meta");
    const assetModalRows = document.getElementById("asset-modal-rows");
    const assetModalClose = document.getElementById("asset-modal-close");
    const currencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];
    let selectedAccountId = payload.firstAccountId;
    let accountFilter = "all";
    let lastModalTrigger = null;
    let activeTxAccount = null;
    let txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
    const hiddenValueLabel = "••••";

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[char];
      });
    }
    function currencySort(left, right) {
      const leftIndex = currencyOrder.indexOf(left);
      const rightIndex = currencyOrder.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      return left.localeCompare(right);
    }
    function money(value, currency) {
      const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
      const safeValue = Object.is(value, -0) ? 0 : Number(value || 0);
      const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(safeValue));
      return (safeValue < 0 ? "-" : "") + currency + " " + formatted;
    }
    function bucketEntries(bucket) {
      return Object.entries(bucket || {}).filter(function(entry) {
        return Number.isFinite(entry[1]);
      }).sort(function(left, right) {
        return currencySort(left[0], right[0]);
      });
    }
    function bucketLines(bucket) {
      const entries = bucketEntries(bucket);
      if (!entries.length) return ["-"];
      return entries.map(function(entry) { return money(entry[1], entry[0]); });
    }
    function sensitiveHtml(value) {
      return '<span data-sensitive>' + escapeHtml(value) + '</span>';
    }
    function applyValueVisibility() {
      const valuesVisible = !valueVisibility || valueVisibility.checked;
      document.documentElement.dataset.valuesVisible = String(valuesVisible);
      if (valueVisibilityLabel) valueVisibilityLabel.textContent = valuesVisible ? "Values visible" : "Values hidden";
      if (valueVisibility) valueVisibility.setAttribute("aria-label", valuesVisible ? "Hide values" : "Show values");
      for (const node of Array.from(document.querySelectorAll("[data-sensitive]"))) {
        if (!node.dataset.value) node.dataset.value = node.textContent || "";
        node.textContent = valuesVisible ? node.dataset.value : hiddenValueLabel;
      }
    }
    function bucketClass(bucket) {
      const first = bucketEntries(bucket).find(function(entry) { return entry[1] !== 0; });
      if (!first) return "neutral";
      return first[1] < 0 ? "negative" : "positive";
    }
    function accountClass(account) {
      if (account.group === "liability") return "liability";
      if (account.group === "investment") return "investment";
      return "asset";
    }
    function signedClass(value) {
      if (value < 0) return "negative";
      if (value > 0) return "positive";
      return "neutral";
    }
    function matchesFilter(account) {
      if (accountFilter === "all") return true;
      return account.group === accountFilter;
    }
    function matchesSearch(account) {
      const query = accountSearch.value.trim().toLowerCase();
      if (!query) return true;
      return [account.label, account.institution, account.kindLabel, account.group, account.source].some(function(field) {
        return String(field || "").toLowerCase().includes(query);
      });
    }
    function selectedAccount() {
      return accounts.find(function(account) { return account.id === selectedAccountId; }) || accounts[0];
    }
    function rowsForAccount(account) {
      return account.transactionIds.map(function(id) { return transactionsById[id]; }).filter(Boolean);
    }
    function assetsForAccount(account) {
      return account.positionIds.map(function(id) { return positionsById[id]; }).filter(Boolean);
    }
    function maskedAccountId(account) {
      const directMask = String(account.label || "").match(/\\*{2,}\\d{4}/);
      if (directMask) return directMask[0];
      for (const asset of assetsForAccount(account)) {
        const assetMask = String(asset.label || "").match(/\\*{2,}\\d{4}/);
        if (assetMask) return assetMask[0];
      }
      return "";
    }
    function accountLine(account) {
      const mask = maskedAccountId(account);
      const parts = [account.institution, account.kindLabel];
      if (mask && mask !== account.label) parts.push(mask);
      if (account.source) parts.push(account.source);
      return parts.join(" · ");
    }
    function valueForAsset(asset) {
      const signedValue = asset.valueSign === "liability" ? -Math.abs(asset.value) : asset.value;
      return money(signedValue, asset.currency);
    }
    function sourceText(item) {
      return String(item.sourceRelativePath || "") + ":" + String(item.sourceRowIndex ?? "");
    }
    function txDateTimeLabel(row) {
      const value = String(row.occurredAt || row.date || "").trim();
      if (!value) return "";
      const normalized = value.replace("T", " ");
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(normalized)) return normalized + " 00:00:00";
      const match = normalized.match(/^(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{1,2}:\\d{2})(?::(\\d{2}))?/);
      if (!match) return normalized;
      const timeParts = match[2].split(":");
      const hour = timeParts[0].padStart(2, "0");
      const minute = timeParts[1].padStart(2, "0");
      const second = (match[3] || "00").padStart(2, "0");
      return match[1] + " " + hour + ":" + minute + ":" + second;
    }
    function txCell(row, key) {
      if (key === "date") return txDateTimeLabel(row);
      if (key === "status") return row.status || "";
      if (key === "description") return row.description || "";
      if (key === "source") return sourceText(row);
      if (key === "amount") return Number(row.amountSigned);
      return "";
    }
    function txSortValue(row, key) {
      if (key === "date") {
        const timestamp = Date.parse(row.occurredAt || row.date || "");
        return Number.isFinite(timestamp) ? timestamp : 0;
      }
      if (key === "amount") {
        const amount = txCell(row, key);
        return Number.isFinite(amount) ? amount : 0;
      }
      return String(txCell(row, key)).toLowerCase();
    }
    function compareTxRows(left, right) {
      const leftValue = txSortValue(left, txTableState.sortKey);
      const rightValue = txSortValue(right, txTableState.sortKey);
      const direction = txTableState.sortDir === "asc" ? 1 : -1;
      if (leftValue > rightValue) return direction;
      if (leftValue < rightValue) return -direction;
      if (txTableState.sortKey === "date") {
        return Number(left.sourceRowIndex ?? 0) - Number(right.sourceRowIndex ?? 0);
      }
      return 0;
    }
    function matchesTxFilter(row) {
      if (txTableState.status !== "all" && row.status !== txTableState.status) return false;
      const query = txTableState.filter.trim().toLowerCase();
      if (!query) return true;
      const amountLabel = Number.isFinite(row.amountSigned) ? money(row.amountSigned, row.currency) : "";
      return [txDateTimeLabel(row), row.status, row.description, sourceText(row), row.currency, amountLabel].some(function(value) {
        return String(value ?? "").toLowerCase().includes(query);
      });
    }
    function resetTxTableControls(rows) {
      txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
      txTableFilter.value = "";
      const statuses = Array.from(new Set(rows.map(function(row) { return String(row.status || "").trim(); }).filter(Boolean))).sort();
      txStatusFilter.innerHTML = '<option value="all">All status</option>' + statuses.map(function(status) {
        return '<option value="' + escapeHtml(status) + '">' + escapeHtml(status) + '</option>';
      }).join("");
      txStatusFilter.value = "all";
    }
    function updateTxSortHeaders() {
      for (const header of txSortHeaders) {
        const key = header.dataset.sortColumn;
        const active = key === txTableState.sortKey;
        if (active) header.setAttribute("aria-sort", txTableState.sortDir === "asc" ? "ascending" : "descending");
        else header.removeAttribute("aria-sort");
        const mark = header.querySelector(".sort-mark");
        if (mark) mark.textContent = active ? (txTableState.sortDir === "asc" ? "↑" : "↓") : "";
      }
    }
    function renderTxRows(account) {
      const rows = rowsForAccount(account);
      const visibleRows = rows.filter(matchesTxFilter).sort(compareTxRows);
      txFilterCount.textContent = String(visibleRows.length) + " / " + String(rows.length) + " rows";
      updateTxSortHeaders();
      if (!visibleRows.length) {
        txModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="5">No matching transactions</td></tr>';
        return;
      }
      txModalRows.innerHTML = visibleRows.map(function(row) {
        const amount = Number(row.amountSigned);
        const amountLabel = Number.isFinite(amount) ? money(amount, row.currency) : "-";
        return '<tr><td>' + escapeHtml(txDateTimeLabel(row) || "-") + '</td><td>' + escapeHtml(row.status || "-") + '</td><td>' + escapeHtml(row.description || "-") + '</td><td>' + escapeHtml(sourceText(row)) + '</td><td class="num ' + (Number.isFinite(amount) ? signedClass(amount) : "neutral") + '">' + sensitiveHtml(amountLabel) + '</td></tr>';
      }).join("");
      applyValueVisibility();
    }
    function renderTxModal(account) {
      const rows = rowsForAccount(account);
      activeTxAccount = account;
      resetTxTableControls(rows);
      txModalTitle.textContent = account.institution + " / " + account.label;
      txModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(rows.length) + ' tx</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span><span class="chip">' + sensitiveHtml(bucketLines(account.amounts).join(" / ")) + '</span>';
      renderTxRows(account);
    }
    function setModalOpenState() {
      document.body.classList.toggle("modal-open", !txModal.hidden || !assetModal.hidden);
    }
    function focusableElements(container) {
      return Array.from(container.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter(function(element) {
        return element.offsetParent !== null || element === document.activeElement;
      });
    }
    function trapModalFocus(event, modal) {
      const elements = focusableElements(modal);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
    function openTxModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderTxModal(account);
      txModal.hidden = false;
      setModalOpenState();
      txModalClose.focus({ preventScroll: true });
    }
    function closeTxModal() {
      txModal.hidden = true;
      activeTxAccount = null;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAssetModal(account) {
      const assets = assetsForAccount(account);
      assetModalTitle.textContent = account.institution + " / " + account.label;
      assetModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(assets.length) + ' ' + (assets.length === 1 ? "asset" : "assets") + '</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span>';
      assetModalRows.innerHTML = assets.map(function(asset) {
        const signClass = asset.valueSign === "liability" ? "negative" : asset.valueSign === "asset" ? "positive" : "neutral";
        return '<tr><td>' + escapeHtml(asset.label) + '</td><td>' + escapeHtml(asset.assetClass) + '</td><td>' + escapeHtml(asset.asOfDate || "-") + '</td><td class="num ' + signClass + '">' + sensitiveHtml(valueForAsset(asset)) + '</td></tr>';
      }).join("");
      if (!assets.length) assetModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="4">No assets</td></tr>';
      applyValueVisibility();
    }
    function openAssetModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderAssetModal(account);
      assetModal.hidden = false;
      setModalOpenState();
      assetModalClose.focus({ preventScroll: true });
    }
    function closeAssetModal() {
      assetModal.hidden = true;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAccounts() {
      const filtered = accounts.filter(matchesFilter).filter(matchesSearch);
      accountCount.textContent = String(filtered.length) + " accounts";
      if (!filtered.some(function(account) { return account.id === selectedAccountId; }) && filtered[0]) selectedAccountId = filtered[0].id;
      if (!filtered.length) {
        accountList.innerHTML = '<div class="empty" role="status"><strong>No matching accounts</strong><span>Adjust the filter or search.</span></div>';
        return;
      }
      accountList.innerHTML = filtered.map(function(account) {
        const txCount = rowsForAccount(account).length;
        const assetCount = assetsForAccount(account).length;
        const amountLines = bucketLines(account.amounts).map(function(line) { return sensitiveHtml(line); }).join("");
        const assetButton = assetCount ? '<button class="chip asset-chip" type="button" data-asset-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="asset-modal">' + String(assetCount) + ' ' + (assetCount === 1 ? "asset" : "assets") + '</button>' : "";
        return '<article class="account-row" role="listitem" data-account-id="' + escapeHtml(account.id) + '" data-selected="' + String(account.id === selectedAccountId) + '"><button class="account-main" type="button" data-select-account-id="' + escapeHtml(account.id) + '" aria-pressed="' + String(account.id === selectedAccountId) + '"><span class="account-name"><strong>' + escapeHtml(account.label) + '</strong><span class="account-line">' + escapeHtml(accountLine(account)) + '</span></span></button><span class="amount ' + bucketClass(account.amounts) + '">' + amountLines + '</span><span class="chip-row account-actions"><span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span>' + assetButton + '<button class="chip tx-chip" type="button" data-tx-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="tx-modal">' + String(txCount) + ' tx</button></span></article>';
      }).join("");
      applyValueVisibility();
      for (const row of Array.from(accountList.querySelectorAll("[data-account-id]"))) {
        row.addEventListener("click", function(event) {
          if (event.target.closest("button")) return;
          selectedAccountId = row.dataset.accountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-select-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.selectAccountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-tx-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.txAccountId;
          renderAccounts();
          openTxModal(selectedAccount(), button);
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-asset-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.assetAccountId;
          renderAccounts();
          openAssetModal(selectedAccount(), button);
        });
      }
    }
    if (valueVisibility) {
      valueVisibility.addEventListener("change", applyValueVisibility);
    }
    for (const button of filterButtons) {
      button.addEventListener("click", function() {
        accountFilter = button.dataset.filter;
        for (const item of filterButtons) item.setAttribute("aria-pressed", String(item === button));
        renderAccounts();
      });
    }
    accountSearch.addEventListener("input", renderAccounts);
    txTableFilter.addEventListener("input", function() {
      txTableState.filter = txTableFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    txStatusFilter.addEventListener("change", function() {
      txTableState.status = txStatusFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    for (const button of txSortButtons) {
      button.addEventListener("click", function() {
        const nextKey = button.dataset.txSort;
        if (txTableState.sortKey === nextKey) txTableState.sortDir = txTableState.sortDir === "asc" ? "desc" : "asc";
        else {
          txTableState.sortKey = nextKey;
          txTableState.sortDir = nextKey === "date" || nextKey === "amount" ? "desc" : "asc";
        }
        if (activeTxAccount) renderTxRows(activeTxAccount);
      });
    }
    txModalClose.addEventListener("click", closeTxModal);
    txModal.querySelector("[data-close-modal]").addEventListener("click", closeTxModal);
    assetModalClose.addEventListener("click", closeAssetModal);
    assetModal.querySelector("[data-close-asset-modal]").addEventListener("click", closeAssetModal);
    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape" && !txModal.hidden) closeTxModal();
      else if (event.key === "Escape" && !assetModal.hidden) closeAssetModal();
      else if (event.key === "Tab" && !txModal.hidden) trapModalFocus(event, txModal);
      else if (event.key === "Tab" && !assetModal.hidden) trapModalFocus(event, assetModal);
    });
    renderAccounts();
  </script>
</body>
</html>`;
}

async function main() {
  const input = inputSchema.parse(parseParams(process.argv.slice(2)));
  const outputDir = resolve(input.outputDir);
  const model = await buildFinancialModel(input);
  const dashboardPath = join(outputDir, "financial_dashboard.html");

  await mkdir(dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, renderLedgerLensDashboard(model), "utf8");

  console.log(
    JSON.stringify(
      {
        schemaVersion: model.schemaVersion,
        generatedAt: model.generatedAt,
        status: model.quality.status,
        counts: model.counts,
        totals: model.totals,
        dashboardPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
