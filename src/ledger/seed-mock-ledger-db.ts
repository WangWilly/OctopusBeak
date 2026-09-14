import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SQLITE_LEDGER_FILE, openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";
import { mockLedgerQueryData } from "../lib/shared-ledger/server/mock-data.ts";
import { sourceVersionKey } from "./source-version.ts";
import { TYPED_STATEMENT_TABLES } from "./source-csv-parsers.ts";

type DbValue = string | number | null;
type DbRecord = Record<string, DbValue | undefined>;
type InputRecord = Record<string, unknown>;

const defaultLedgerDir = "data/mock-ledger";

function main() {
  const ledgerDir = resolve(process.argv[2] ?? defaultLedgerDir);
  const sqlitePath = seedMockLedger(ledgerDir);

  console.log(`Mock ledger written to ${sqlitePath}`);
  console.log("Desktop mock shortcut: npm run desktop:dev:mock");
}

export function seedMockLedger(ledgerDir: string, referenceDate = new Date()): string {
  ledgerDir = resolve(ledgerDir);
  mkdirSync(ledgerDir, { recursive: true });
  cleanSqliteFiles(ledgerDir);

  const db = openLedgerDatabase(ledgerDir);
  try {
    seed(db, referenceDate);
  } finally {
    db.close();
  }
  return `${ledgerDir}/${SQLITE_LEDGER_FILE}`;
}

function cleanSqliteFiles(ledgerDir: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${ledgerDir}/${SQLITE_LEDGER_FILE}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}

function seed(db: LedgerDatabase, referenceDate: Date) {
  const data = mockLedgerQueryData(referenceDate);
  const importRunId = data.importRuns[0]?.importRunId ?? "mock-run";
  const importedAt = data.importRuns[0]?.finishedAt ?? new Date().toISOString();
  const sourceFiles = data.sourceFiles.map((row) => sourceFileRecord({
    ...row,
    rowCount: row.sourceFileId === "account.2026-06-27" ? 8 : row.rowCount,
  }));

  db.exec("BEGIN");
  try {
    insertRows(db, "import_runs", data.importRuns);
    insertRows(db, "import_run_events", [
      {
        importRunId,
        eventType: "started",
        eventAt: data.importRuns[0]?.startedAt ?? importedAt,
        recordJson: json({ recordType: "mock-import-event", eventType: "started" }),
      },
      {
        importRunId,
        eventType: "completed",
        eventAt: importedAt,
        recordJson: json({ recordType: "mock-import-event", eventType: "completed" }),
      },
    ]);
    insertRows(db, "source_files", sourceFiles);
    insertRows(db, "source_file_imports", sourceFiles.map(canonicalSourceFileRecord));
    insertRows(db, "account_transactions", [
      ...data.accountTransactions,
      {
        ...commonRow(importRunId, importedAt, "account.2026-06-27", "fubon", "deposit", 6),
        accountName: "富邦薪轉帳戶",
        accountNumber: "MOCK-PAYROLL",
        currency: "TWD",
        accountingDate: relativeIso(referenceDate, -1, 10, 20).slice(0, 10),
        transactionDate: relativeIso(referenceDate, -1, 10, 20).slice(0, 10),
        transactionTime: "10:20:00",
        transactionAtUtc: relativeIso(referenceDate, -1, 10, 20),
        description: "金融卡消費 咖啡店",
        withdrawalAmount: 180,
        depositAmount: null,
        balanceAfter: 117400,
        note: null,
        fxRate: null,
      },
      {
        ...commonRow(importRunId, importedAt, "account.2026-06-27", "fubon", "deposit", 7),
        accountName: "富邦薪轉帳戶",
        accountNumber: "MOCK-PAYROLL",
        currency: "TWD",
        accountingDate: relativeIso(referenceDate, -2, 9, 15).slice(0, 10),
        transactionDate: relativeIso(referenceDate, -2, 9, 15).slice(0, 10),
        transactionTime: "09:15:00",
        transactionAtUtc: relativeIso(referenceDate, -2, 9, 15),
        description: "繳信用卡",
        withdrawalAmount: 8888,
        depositAmount: null,
        balanceAfter: 108512,
        note: null,
        fxRate: null,
      },
      {
        ...commonRow(importRunId, importedAt, "account.2026-06-27", "fubon", "deposit", 8),
        accountName: "富邦數位備用金",
        accountNumber: "MOCK-EMERGENCY",
        currency: "TWD",
        accountingDate: relativeIso(referenceDate, -3, 12, 40).slice(0, 10),
        transactionDate: relativeIso(referenceDate, -3, 12, 40).slice(0, 10),
        transactionTime: "12:40:00",
        transactionAtUtc: relativeIso(referenceDate, -3, 12, 40),
        description: "房租轉帳轉入",
        withdrawalAmount: null,
        depositAmount: 28000,
        balanceAfter: 445000,
        note: null,
        fxRate: null,
      },
    ]);
    insertRows(db, "foreign_currency_transactions", data.foreignCurrencyTransactions);
    insertRows(db, "credit_card_statement_lines", data.creditCardStatementLines);
    insertRows(db, "loan_transactions", data.loanTransactions);
    insertRows(db, "fund_holdings", data.fundHoldings);
    insertRows(db, "fund_buy_transactions", data.fundBuyTransactions);
    insertRows(db, "fund_redemption_transactions", data.fundRedemptionTransactions);
    insertRows(db, "fund_cash_dividends", data.fundCashDividends);
    insertRows(db, "fund_conversion_transactions", data.fundConversionTransactions);
    insertRows(db, "brokerage_holdings", data.brokerageHoldings);
    insertRows(db, "brokerage_asset_summaries", [
      {
        ...commonRow(importRunId, importedAt, "brokerage.2026-06-27", "yuanta-brokerage", "brokerage", 5),
        asOfDate: data.brokerageHoldings[0]?.asOfDate ?? importedAt.slice(0, 10),
        assetType: "total",
        assetName: "證券資產總計",
        assetValueTwd: 858000,
        unrealizedPnlTwd: 76500,
      },
    ]);
    insertRows(db, "brokerage_trade_transactions", data.brokerageTradeTransactions);
    insertRows(db, "unsupported_statement_rows", [
      {
        ...commonRow(importRunId, importedAt, "unsupported.2026-06-27", "demo-bank", "unknown-export", 1),
        reason: "mock unsupported layout",
        headersJson: json(["欄位A", "欄位B"]),
      },
    ]);
    insertRows(db, "maicoin_sync_runs", [
      {
        syncRunId: "mock-maicoin-run",
        startedAt: relativeIso(referenceDate, 0, 11, 58),
        finishedAt: relativeIso(referenceDate, 0, 12, 0),
        subAccount: "main",
        walletTypesJson: json(["spot", "m"]),
        statementEnabled: 1,
        statementLimit: 100,
        recordJson: json({ recordType: "mock-maicoin-sync-run" }),
      },
    ]);
    insertRows(db, "maicoin_account_snapshots", data.maicoinAccountSnapshots);
    insertRows(db, "maicoin_statement_rows", data.maicoinStatementRows);
    seedSourceRowLineage(db);
    insertRows(db, "automation_task_runs", automationTaskRuns(referenceDate));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function automationTaskRuns(referenceDate: Date): InputRecord[] {
  return [
    ["fubon-all-statements", "run:fubon-all-statements", "crawler", "completed", 8, null],
  ].map(([taskId, script, kind, status, hour, error]) => ({
    taskRunId: `mock-${taskId}-${status}`,
    taskId,
    script,
    kind,
    status,
    attempt: 1,
    maxAttempts: 2,
    startedAt: relativeIso(referenceDate, 0, Number(hour), 0),
    finishedAt: relativeIso(referenceDate, 0, Number(hour), 2),
    exitCode: status === "completed" ? 0 : 1,
    signal: null,
    errorMessage: error,
    logPath: `data/automation/logs/mock-${taskId}.log`,
    logTail: error ?? "automation-progress: 100",
    recordJson: json({ mock: true, taskId, status }),
  }));
}

function relativeIso(referenceDate: Date, dayOffset: number, hour: number, minute: number): string {
  const date = taipeiCalendarDate(referenceDate);
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + dayOffset,
    hour,
    minute,
  )).toISOString();
}

function relativeMonthUnix(
  referenceDate: Date,
  monthOffset: number,
  day: number,
  hour: number,
): number {
  const date = taipeiCalendarDate(referenceDate);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthOffset, day, hour) / 1000;
}

function taipeiCalendarDate(value: Date): Date {
  const parts = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Asia/Taipei",
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(number("year"), number("month") - 1, number("day")));
}

function sourceFileRecord(row: InputRecord): DbRecord {
  const sourceFileId = String(row.sourceFileId);
  return {
    ...row,
    sourceSheetName: null,
    csvLayoutJson: json({ strategy: "mock" }),
    headersJson: json(["date", "description", "amount", "balance"]),
    recordKeysJson: json(["date", "description"]),
    relatedRawFilesJson: json([]),
    relatedRawFileMetadataJson: json([]),
    recordJson: json({ recordType: "mock-source-file", sourceFileId }),
  };
}

function canonicalSourceFileRecord(row: InputRecord): DbRecord {
  const importedAt = String(row.importedAt);
  return {
    ...row,
    sourceVersionKey: sourceVersionKey(
      String(row.bank),
      String(row.product),
      String(row.sourceFileHash),
    ),
    firstSeenAt: String(row.firstSeenAt ?? importedAt),
    lastSeenAt: String(row.lastSeenAt ?? importedAt),
    observationCount: Number(row.observationCount ?? 1),
  };
}

function seedSourceRowLineage(db: LedgerDatabase) {
  for (const table of TYPED_STATEMENT_TABLES) {
    db.exec(`
      INSERT INTO source_row_lineage (
        source_file_id, import_run_id, source_version_key, source_row_index,
        projection_table, statement_row_id, outcome, created_at
      )
      SELECT typed.source_file_id, typed.import_run_id, source.source_version_key,
        typed.source_row_index, '${table}', typed.statement_row_id, 'inserted', typed.imported_at
      FROM ${table} AS typed
      JOIN source_file_imports AS source USING (source_file_id, import_run_id)
    `);
  }
}

function commonRow(
  importRunId: string,
  importedAt: string,
  sourceFileId: string,
  bank: string,
  product: string,
  sourceRowIndex: number,
): DbRecord {
  const id = `${sourceFileId}.${sourceRowIndex}`;
  return {
    statementRowId: `mock-${id}`,
    sourceFileId,
    importRunId,
    sourceRelativePath: `mock/${sourceFileId}.csv`,
    sourceRowIndex,
    sourceHash: `mock-source-${id}`,
    contentHash: `mock-content-${id}`,
    bank,
    product,
    rawPayloadJson: json({ mock: true }),
    importedAt,
    createdAt: importedAt,
  };
}

function insertRows(db: LedgerDatabase, table: string, rows: InputRecord[]) {
  for (const row of rows) insertRow(db, table, row);
}

function insertRow(db: LedgerDatabase, table: string, row: InputRecord) {
  const columns = tableColumns(db, table);
  const values = normalizeRecord(row);
  const insertColumns = columns
    .filter((column) => values[column.name] !== undefined)
    .map((column) => column.name);
  const missingRequired = columns
    .filter((column) => column.notnull && !column.pk && column.dflt_value === null)
    .filter((column) => values[column.name] === undefined)
    .map((column) => column.name);

  if (missingRequired.length > 0) {
    throw new Error(`Missing required columns for ${table}: ${missingRequired.join(", ")}`);
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  db.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
  ).run(...insertColumns.map((column) => values[column] ?? null));
}

function tableColumns(db: LedgerDatabase, table: string) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    defaultValue?: string | null;
  }>;
}

function normalizeRecord(row: InputRecord): DbRecord {
  const normalized: DbRecord = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[toSnakeCase(key)] = value === undefined ? undefined : (value as DbValue);
  }
  return normalized;
}

function toSnakeCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function json(value: unknown) {
  return JSON.stringify(value);
}

const isCliEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCliEntry) main();
