import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SQLITE_LEDGER_FILE, openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";
import { mockLedgerQueryData } from "../lib/shared-ledger/server/mock-data.ts";

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
  const invoiceData = personalInvoiceFixtures(importRunId, importedAt, referenceDate);

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
    insertRows(db, "source_files", [
      ...data.sourceFiles.map(sourceFileRecord),
      sourceFileRecord(invoiceData.sourceFile),
    ]);
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
        ...commonRow(importRunId, importedAt, "unsupported.current", "demo-bank", "unknown-export", 1),
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
    insertRows(db, "personal_invoices", invoiceData.invoices);
    insertRows(db, "personal_invoice_items", invoiceData.items);
    insertRows(db, "automation_task_runs", automationTaskRuns(referenceDate));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function personalInvoiceFixtures(importRunId: string, importedAt: string, referenceDate: Date) {
  const sourceFileId = "einvoice.personal.current";
  const templates = [
    {
      month: 0, invoiceId: "AA10000001", sellerId: "16740494", seller: "全聯福利中心新店中正店",
      addr: "新北市新店區中正路199號", items: [
        ["有機鮮奶", 1, 95, "food"], ["抽取式衛生紙", 1, 189, "daily"],
      ],
    },
    {
      month: 0, invoiceId: "AA10000002", sellerId: "24536806", seller: "台灣大車隊股份有限公司",
      addr: "台北市中山區濱江街136號", items: [["計程車車資", 1, 285, "transport"]],
    },
    {
      month: 0, invoiceId: "AA10000003", sellerId: "27952966", seller: "宜家家居股份有限公司新店分公司",
      addr: "新北市新店區中央路159號", items: [["LED 閱讀燈", 1, 799, "home"]],
    },
    {
      month: 1, invoiceId: "BB20000001", sellerId: "23525871", seller: "台灣優衣庫有限公司",
      addr: "台北市信義區松高路12號", items: [["亞麻襯衫", 1, 990, "shopping"]],
    },
    {
      month: 1, invoiceId: "BB20000002", sellerId: "54396490", seller: "網飛服務有限公司",
      addr: "台北市信義區信義路五段7號", items: [["影音月費", 1, 390, "leisure"]],
    },
    {
      month: 1, invoiceId: "BB20000003", sellerId: "60616841", seller: "三民晨食有限公司",
      addr: "新北市新店區三民路40號", items: [["里肌蛋吐司", 1, 65, "food"], ["冰豆漿", 1, 30, "food"]],
    },
    {
      month: 2, invoiceId: "CC30000001", sellerId: "03795904", seller: "台灣電力公司",
      addr: "台北市中正區羅斯福路三段242號", items: [["住宅電費", 1, 1268, "daily"]],
    },
    {
      month: 2, invoiceId: "CC30000002", sellerId: "38443075", seller: "台灣中油新店站",
      addr: "新北市新店區北新路一段90號", items: [["95 無鉛汽油", 22.4, 31.2, "transport"]],
    },
    {
      month: 3, invoiceId: "DD40000001", sellerId: "24789086", seller: "便利生活服務股份有限公司",
      addr: "台北市大安區復興南路一段1號", items: [["代收服務費", 1, 15, "other"]],
    },
  ] as const;
  const invoices: InputRecord[] = [];
  const items: InputRecord[] = [];
  let rowIndex = 1;

  for (const template of templates) {
    const invoiceKey = `${template.invoiceId}|${template.sellerId}`;
    const issuedAt = relativeMonthUnix(referenceDate, template.month, 10, 12);
    const amount = template.items.reduce((sum, item) => sum + item[1] * item[2], 0);
    invoices.push({
      ...commonRow(importRunId, importedAt, sourceFileId, "einvoice", "personal-invoices", rowIndex),
      invoiceKey,
      carrierCustomizedName: "手機條碼",
      issuedAt,
      invoiceId: template.invoiceId,
      amount,
      status: "confirmed",
      rebated: 0,
      sellerBusinessAccountNumber: template.sellerId,
      sellerName: template.seller,
      sellerAddr: template.addr,
      buyerBusinessAccountNumber: "",
    });
    template.items.forEach(([name, quantity, unitPrice, category], index) => {
      items.push({
        ...commonRow(importRunId, importedAt, sourceFileId, "einvoice", "personal-invoices", rowIndex),
        itemKey: `${invoiceKey}|${index + 1}`,
        invoiceKey,
        itemSequenceNumber: index + 1,
        itemQuantity: quantity,
        itemUnitPrice: unitPrice,
        itemPaidAmount: quantity * unitPrice,
        itemProductName: name,
        category,
      });
      rowIndex += 1;
    });
  }

  const voidedKey = "ZZ90000001|70762591";
  invoices.push({
    ...commonRow(importRunId, importedAt, sourceFileId, "einvoice", "personal-invoices", rowIndex),
    invoiceKey: voidedKey,
    carrierCustomizedName: "手機條碼",
    issuedAt: relativeMonthUnix(referenceDate, 0, 8, 18),
    invoiceId: "ZZ90000001",
    amount: 450,
    status: "voided",
    rebated: 0,
    sellerBusinessAccountNumber: "70762591",
    sellerName: "測試取消交易商店",
    sellerAddr: "台北市中正區忠孝西路一段1號",
    buyerBusinessAccountNumber: "",
  });
  items.push({
    ...commonRow(importRunId, importedAt, sourceFileId, "einvoice", "personal-invoices", rowIndex),
    itemKey: `${voidedKey}|1`,
    invoiceKey: voidedKey,
    itemSequenceNumber: 1,
    itemQuantity: 1,
    itemUnitPrice: 450,
    itemPaidAmount: 450,
    itemProductName: "已取消商品",
    category: "other",
  });

  return {
    sourceFile: {
      sourceFileId,
      importRunId,
      sourceFile: "downloads/einvoice-personal-invoices/mock-current.csv",
      sourceRelativePath: "einvoice-personal-invoices/mock-current.csv",
      sourceFileHash: "mock-file-hash-einvoice-current",
      sourceFileBytes: items.length * 256,
      sourceFileModifiedAt: relativeIso(referenceDate, 0, 9, 0),
      importedAt,
      bank: "einvoice",
      product: "personal-invoices",
      rowCount: items.length,
      status: "imported",
    },
    invoices,
    items,
  };
}

function automationTaskRuns(referenceDate: Date): InputRecord[] {
  return [
    ["fubon-all-statements", "run:fubon-all-statements", "crawler", "completed", 8, null],
    ["einvoice-personal-invoices", "run:einvoice-personal-invoices", "crawler", "failed", 9, "CAPTCHA verification expired"],
    ["import-downloads-csv", "run:import-downloads-csv", "import", "completed", 10, null],
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

const isCliEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCliEntry) main();
