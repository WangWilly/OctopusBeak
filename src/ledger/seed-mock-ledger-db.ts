import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SQLITE_LEDGER_FILE, openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";
import { mockLedgerQueryData } from "../lib/shared-ledger/server/mock-data.ts";

type DbValue = string | number | null;
type DbRecord = Record<string, DbValue | undefined>;
type InputRecord = Record<string, unknown>;

const defaultLedgerDir = "data/mock-ledger";

function main() {
  const ledgerDir = resolve(process.argv[2] ?? defaultLedgerDir);
  mkdirSync(ledgerDir, { recursive: true });
  cleanSqliteFiles(ledgerDir);

  const db = openLedgerDatabase(ledgerDir);
  try {
    seed(db);
  } finally {
    db.close();
  }

  console.log(`Mock ledger written to ${ledgerDir}/${SQLITE_LEDGER_FILE}`);
  console.log(`Run with: ${process.argv[2] ? `LEDGER_DIR=${ledgerDir} npm run dev` : "npm run dev:mock"}`);
}

function cleanSqliteFiles(ledgerDir: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${ledgerDir}/${SQLITE_LEDGER_FILE}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}

function seed(db: LedgerDatabase) {
  const data = mockLedgerQueryData();
  const importRunId = data.importRuns[0]?.importRunId ?? "mock-run";
  const importedAt = data.importRuns[0]?.finishedAt ?? new Date().toISOString();

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
    insertRows(db, "source_files", data.sourceFiles.map(sourceFileRecord));
    insertRows(db, "account_transactions", data.accountTransactions);
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
        asOfDate: "2026-06-27",
        assetType: "total",
        assetName: "Mock brokerage total",
        assetValueTwd: 501000,
        unrealizedPnlTwd: 78500,
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
        startedAt: "2026-06-27T11:58:00.000Z",
        finishedAt: "2026-06-27T12:00:00.000Z",
        subAccount: "main",
        walletTypesJson: json(["spot", "m"]),
        statementEnabled: 1,
        statementLimit: 100,
        recordJson: json({ recordType: "mock-maicoin-sync-run" }),
      },
    ]);
    insertRows(db, "maicoin_account_snapshots", data.maicoinAccountSnapshots);
    insertRows(db, "maicoin_statement_rows", data.maicoinStatementRows);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
    rawRowHash: `mock-raw-${id}`,
    contentHash: `mock-content-${id}`,
    bank,
    product,
    dedupeStatus: "unique",
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

main();
