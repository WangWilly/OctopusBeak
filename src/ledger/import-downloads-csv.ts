import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import XLSX from "xlsx";
import { z } from "zod";
import {
  ledgerSqlitePath,
  openLedgerDatabase,
  type LedgerDatabase,
} from "./db/client.ts";
import {
  contentHashForRow,
  hashBytes,
  stableStringify,
} from "./content-hash.ts";
import {
  createSourceCsvParser,
  personalInvoiceFields,
  personalInvoiceItemFields,
  type SourceMetadata,
} from "./source-csv-parsers.ts";
import { classifyPersonalInvoiceItem } from "../lib/spending/categories.ts";
import { creditCardContentKey } from "./credit-card-identity.ts";
import {
  assignOccurrenceIndexes,
  captureCardRowCounts,
  fullCreditCardCaptureMetadataSchema,
} from "./credit-card-capture.ts";

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

type FullCreditCardCaptureMetadata = z.infer<
  typeof fullCreditCardCaptureMetadataSchema
>;

const RAW_LEDGER_SCHEMA_VERSION = "raw-ledger.v1";
const IMPORTER_NAME = "import-downloads-csv";
const IMPORTER_VERSION = "1";

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
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT"
      || error instanceof SyntaxError
    ) return null;
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

export function insertRecord(
  db: LedgerDatabase,
  table: string,
  record: Record<string, unknown>,
): "inserted" | "duplicate" {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  try {
    db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    ).run(...columns.map((column) => sqliteValue(record[column])));
    return "inserted";
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes(`UNIQUE constraint failed: ${table}.content_hash`)
    ) return "duplicate";
    throw error;
  }
}

const PERSONAL_INVOICE_UPDATE_COLUMNS = [
  "statement_row_id",
  "source_file_id",
  "import_run_id",
  "source_relative_path",
  "source_row_index",
  "source_hash",
  "content_hash",
  "raw_payload_json",
  "imported_at",
  "carrier_customized_name",
  "issued_at",
  "invoice_id",
  "amount",
  "status",
  "rebated",
  "seller_business_account_number",
  "seller_name",
  "seller_addr",
  "buyer_business_account_number",
] as const;

const PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS = [
  // Category is a user-editable classification and must survive reimports.
  "statement_row_id",
  "source_file_id",
  "import_run_id",
  "source_relative_path",
  "source_row_index",
  "source_hash",
  "content_hash",
  "raw_payload_json",
  "imported_at",
  "invoice_key",
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
] as const;

const SOURCE_FILE_UPDATE_COLUMNS = [
  "source_file_id",
  "import_run_id",
  "source_file",
  "source_file_hash",
  "source_file_bytes",
  "source_file_modified_at",
  "imported_at",
  "bank",
  "product",
  "source_sheet_name",
  "csv_layout_json",
  "headers_json",
  "record_keys_json",
  "related_raw_files_json",
  "related_raw_file_metadata_json",
  "row_count",
  "status",
  "record_json",
] as const;

function upsertRecord(
  db: LedgerDatabase,
  table: string,
  record: Record<string, unknown>,
  conflictColumn: string,
  updateColumns: readonly string[],
) {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  const assignments = updateColumns
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${conflictColumn}) DO UPDATE SET ${assignments}`,
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
  upsertRecord(
    db,
    "source_files",
    sourceFileRecordFromBatch(record),
    "source_relative_path",
    SOURCE_FILE_UPDATE_COLUMNS,
  );
}

function commonTypedRowFields(
  sourceFileRecord: Record<string, unknown>,
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash?: string;
    sourceHash?: string;
    contentHash?: string;
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
    content_hash: contentHash,
    bank: String(sourceFileRecord.bank ?? ""),
    product: String(sourceFileRecord.product ?? ""),
    raw_payload_json: JSON.stringify(row.rawPayload),
    imported_at: String(sourceFileRecord.importedAt ?? ""),
  };
}

function insertPersonalInvoiceStatementRow(
  db: LedgerDatabase,
  sourceFileRecord: Record<string, unknown>,
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash?: string;
    sourceHash?: string;
    contentHash?: string;
  },
) {
  const commonFields = commonTypedRowFields(sourceFileRecord, row);
  upsertRecord(
    db,
    "personal_invoices",
    {
      ...commonFields,
      ...personalInvoiceFields(row.rawPayload),
    },
    "invoice_key",
    PERSONAL_INVOICE_UPDATE_COLUMNS,
  );
  upsertRecord(
    db,
    "personal_invoice_items",
    {
      ...commonFields,
      ...personalInvoiceItemFields(row.rawPayload),
      category: classifyPersonalInvoiceItem({
        productName: row.rawPayload.item_product_name ?? "",
        sellerName: row.rawPayload.seller_name ?? "",
        sellerAddr: row.rawPayload.seller_addr ?? "",
      }),
    },
    "item_key",
    PERSONAL_INVOICE_ITEM_UPDATE_COLUMNS,
  );
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
  },
): "inserted" | "duplicate" | "upserted" {
  const bank = String(sourceFileRecord.bank ?? "");
  const product = String(sourceFileRecord.product ?? "");
  if (bank === "einvoice" && product === "personal-invoices") {
    insertPersonalInvoiceStatementRow(db, sourceFileRecord, row);
    return "upserted";
  }
  const sourceRelativePath = String(sourceFileRecord.sourceRelativePath ?? "");
  const headers = Array.isArray(sourceFileRecord.headers)
    ? (sourceFileRecord.headers as string[])
    : [];
  const parser = createSourceCsvParser({
    bank,
    product,
    sourceRelativePath,
    metadata: (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    headers,
  });
  const parsedFields = parser.parseRow(row.rawPayload);
  return insertRecord(db, parser.table, {
    ...commonTypedRowFields(sourceFileRecord, row),
    ...parsedFields,
    ...(parser.table === "credit_card_statement_lines"
      ? { semantic_key: contentKeyForCreditCardFields(bank, parsedFields) }
      : {}),
  });
}

function contentKeyForCreditCardFields(
  bank: string,
  fields: Record<string, unknown>,
) {
  return creditCardContentKey({
    bank,
    cardNumber: String(fields.card_number ?? ""),
    statementType: String(fields.statement_type ?? ""),
    consumeDate: String(fields.consume_date ?? ""),
    description: String(fields.description ?? ""),
    foreignCurrency: String(fields.foreign_currency ?? ""),
    foreignAmount: fields.foreign_amount as number | string | null,
    twdAmount: fields.twd_amount as number | string | null,
    installmentAction: String(fields.installment_action ?? ""),
    paymentStatus: String(fields.payment_status ?? ""),
  });
}

type ImportStatementRow = {
  sourceFileRecord: Record<string, unknown>;
  row: {
    sourceRowIndex: number;
    rawPayload: Record<string, string>;
    rawRowHash: string;
    sourceHash: string;
    contentHash: string;
  };
};

type CreditCardRow = ImportStatementRow & {
  sourceFileId: string;
  bank: string;
  product: string;
  statementType: string;
  cardKey: string;
  contentKey: string;
  fields: Record<string, unknown>;
  statementRowId?: string;
};

type VerifiedCreditCardCapture = {
  captureId: string;
  capturedAt: string;
  bank: string;
  product: string;
  metadata: FullCreditCardCaptureMetadata;
  files: Array<{ sourceFileRecord: Record<string, unknown>; statementType: string }>;
};

function creditCardParser(sourceFileRecord: Record<string, unknown>) {
  const sourceRelativePath = String(sourceFileRecord.sourceRelativePath ?? "");
  return createSourceCsvParser({
    bank: String(sourceFileRecord.bank ?? ""),
    product: String(sourceFileRecord.product ?? ""),
    sourceRelativePath,
    metadata: (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    headers: Array.isArray(sourceFileRecord.headers)
      ? sourceFileRecord.headers as string[]
      : [],
  });
}

function isFubonCreditCardSummary(
  bank: string,
  fields: Record<string, unknown>,
) {
  return bank === "fubon" && ["網路繳款", "行動銀行繳款", "前期應繳總額"].includes(
    String(fields.description ?? "").trim(),
  );
}

function parsedCreditCardRows(statementRows: ImportStatementRow[]): CreditCardRow[] {
  const rows: CreditCardRow[] = [];
  for (const item of statementRows) {
    const parser = creditCardParser(item.sourceFileRecord);
    if (parser.table !== "credit_card_statement_lines") continue;
    const fields = parser.parseRow(item.row.rawPayload);
    const bank = String(item.sourceFileRecord.bank ?? "");
    if (isFubonCreditCardSummary(bank, fields)) continue;
    const sourceRelativePath = String(item.sourceFileRecord.sourceRelativePath ?? "");
    rows.push({
      ...item,
      sourceFileId: sourceFileIdForPath(sourceRelativePath),
      bank,
      product: String(item.sourceFileRecord.product ?? ""),
      statementType: String(fields.statement_type ?? ""),
      cardKey: String(fields.card_number ?? "").replace(/\D/g, "").slice(-4),
      contentKey: contentKeyForCreditCardFields(bank, fields),
      fields,
    });
  }
  return rows;
}

function persistedCreditCardEvidence(
  db: LedgerDatabase,
  sourceFileRecords: Record<string, unknown>[],
) {
  const captureIds = new Set(sourceFileRecords.flatMap((sourceFileRecord) => {
    if (creditCardParser(sourceFileRecord).table !== "credit_card_statement_lines") {
      return [];
    }
    const metadata = fullCaptureMetadata(
      (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    );
    return metadata ? [metadata.captureId] : [];
  }));
  if (captureIds.size === 0) {
    return { sourceFileRecords: [], cardRows: [] as CreditCardRow[] };
  }

  const persistedSourceFileRecords: Record<string, unknown>[] = [];
  const statementRows: ImportStatementRow[] = [];
  const persistedRecords = db.prepare("SELECT record_json FROM source_files").all() as Array<{
    record_json: string;
  }>;
  for (const { record_json } of persistedRecords) {
    let sourceFileRecord: Record<string, unknown>;
    try {
      sourceFileRecord = JSON.parse(record_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (creditCardParser(sourceFileRecord).table !== "credit_card_statement_lines") {
      continue;
    }
    const metadata = fullCaptureMetadata(
      (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    );
    if (!metadata || !captureIds.has(metadata.captureId)) continue;

    persistedSourceFileRecords.push(sourceFileRecord);
    const sourceFileId = sourceFileIdForPath(
      String(sourceFileRecord.sourceRelativePath ?? ""),
    );
    const persistedRows = db.prepare(`
      SELECT statement_row_id, source_row_index, source_hash, content_hash, raw_payload_json
      FROM credit_card_statement_lines
      WHERE source_file_id = ?
    `).all(sourceFileId) as Array<{
      statement_row_id: string;
      source_row_index: number;
      source_hash: string;
      content_hash: string;
      raw_payload_json: string;
    }>;
    for (const persistedRow of persistedRows) {
      const rawPayload = JSON.parse(persistedRow.raw_payload_json) as Record<string, string>;
      statementRows.push({
        sourceFileRecord,
        row: {
          sourceRowIndex: persistedRow.source_row_index,
          rawPayload,
          rawRowHash: hashBytes(stableStringify(rawPayload)),
          sourceHash: persistedRow.source_hash,
          contentHash: persistedRow.content_hash,
        },
      });
    }
  }
  return {
    sourceFileRecords: persistedSourceFileRecords,
    cardRows: parsedCreditCardRows(statementRows),
  };
}

function fullCaptureMetadata(
  metadata: SourceMetadata | null,
): FullCreditCardCaptureMetadata | null {
  const parsed = fullCreditCardCaptureMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function sameCardKeys(left: Record<string, number>, right: Record<string, number>) {
  return stableStringify(Object.keys(left).sort()) === stableStringify(Object.keys(right).sort());
}

function verifiedCreditCardCaptures(
  sourceFileRecords: Record<string, unknown>[],
  cardRows: CreditCardRow[],
) {
  const candidates = new Map<string, Array<{
    sourceFileRecord: Record<string, unknown>;
    statementType: string;
    metadata: FullCreditCardCaptureMetadata;
  }>>();
  for (const sourceFileRecord of sourceFileRecords) {
    if (creditCardParser(sourceFileRecord).table !== "credit_card_statement_lines") continue;
    const metadata = fullCaptureMetadata(
      (sourceFileRecord.sourceMetadata ?? null) as SourceMetadata | null,
    );
    if (!metadata) continue;
    const sourceRelativePath = String(sourceFileRecord.sourceRelativePath ?? "");
    const statementType = sourceRelativePath.includes("unbilled") ? "unbilled" : "billed";
    const files = candidates.get(metadata.captureId) ?? [];
    files.push({ sourceFileRecord, statementType, metadata });
    candidates.set(metadata.captureId, files);
  }

  const verified = new Map<string, VerifiedCreditCardCapture>();
  for (const [captureId, files] of candidates) {
    if (files.length !== 2) continue;
    const [first, second] = files;
    if (
      new Set(files.map((file) => file.statementType)).size !== 2
      || !files.every((file) => file.metadata.capturedAt === first.metadata.capturedAt)
      || !files.every((file) => (
        String(file.sourceFileRecord.bank ?? "") === String(first.sourceFileRecord.bank ?? "")
        && String(file.sourceFileRecord.product ?? "") === String(first.sourceFileRecord.product ?? "")
      ))
      || !files.every((file) => sameCardKeys(file.metadata.cardRowCounts, first.metadata.cardRowCounts))
    ) continue;

    const cardKeys = Object.keys(first.metadata.cardRowCounts);
    const countsMatch = files.every((file) => {
      const sourceFileId = sourceFileIdForPath(
        String(file.sourceFileRecord.sourceRelativePath ?? ""),
      );
      return stableStringify(captureCardRowCounts(
        cardKeys,
        cardRows.filter((row) => row.sourceFileId === sourceFileId),
      )) === stableStringify(file.metadata.cardRowCounts);
    });
    if (!countsMatch) continue;

    verified.set(captureId, {
      captureId,
      capturedAt: first.metadata.capturedAt,
      bank: String(first.sourceFileRecord.bank ?? ""),
      product: String(first.sourceFileRecord.product ?? ""),
      metadata: first.metadata,
      files: files.map(({ sourceFileRecord, statementType }) => ({
        sourceFileRecord,
        statementType,
      })),
    });
  }
  return verified;
}

function upsertCanonicalCreditCardLine(
  db: LedgerDatabase,
  row: CreditCardRow & { occurrenceIndex: number; seenAt: string },
) {
  const existing = db.prepare(`
    SELECT statement_row_id FROM credit_card_statement_lines
    WHERE content_key = ? AND occurrence_index = ?
  `).get(row.contentKey, row.occurrenceIndex) as { statement_row_id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE credit_card_statement_lines SET last_seen_at = ?
      WHERE statement_row_id = ?
    `).run(row.seenAt, existing.statement_row_id);
    return existing.statement_row_id;
  }
  const record = {
    ...commonTypedRowFields(row.sourceFileRecord, row.row),
    ...row.fields,
    semantic_key: row.contentKey,
    content_key: row.contentKey,
    occurrence_index: row.occurrenceIndex,
    first_seen_at: row.seenAt,
    last_seen_at: row.seenAt,
  };
  insertRecord(db, "credit_card_statement_lines", record);
  return String(record.statement_row_id);
}

function insertVerifiedCreditCardState(
  db: LedgerDatabase,
  cardRows: CreditCardRow[],
  captures: Map<string, VerifiedCreditCardCapture>,
  seenAt: string,
) {
  const captureIdBySourceFileId = new Map<string, string>();
  for (const capture of captures.values()) {
    for (const file of capture.files) {
      captureIdBySourceFileId.set(
        sourceFileIdForPath(String(file.sourceFileRecord.sourceRelativePath ?? "")),
        capture.captureId,
      );
    }
  }

  const canonicalGroups = new Map<string, CreditCardRow[]>();
  for (const row of cardRows) {
    const captureId = captureIdBySourceFileId.get(row.sourceFileId);
    const groupKey = captureId ?? `source:${row.sourceFileId}`;
    const rows = canonicalGroups.get(groupKey) ?? [];
    rows.push(row);
    canonicalGroups.set(groupKey, rows);
  }
  for (const [groupKey, rows] of canonicalGroups) {
    const capture = captures.get(groupKey);
    for (const { row, occurrenceIndex } of assignOccurrenceIndexes(rows.map((row) => ({
      row,
      contentKey: row.contentKey,
      sourceRowIndex: row.row.sourceRowIndex,
    })))) {
      row.statementRowId = upsertCanonicalCreditCardLine(db, {
        ...row,
        occurrenceIndex,
        seenAt: capture?.capturedAt ?? seenAt,
      });
    }
  }

  for (const capture of captures.values()) {
    insertRecord(db, "credit_card_captures", {
      capture_id: capture.captureId,
      bank: capture.bank,
      product: capture.product,
      captured_at: capture.capturedAt,
      completeness_json: JSON.stringify(capture.metadata.completenessEvidence),
    });
    for (const row of cardRows) {
      if (captureIdBySourceFileId.get(row.sourceFileId) !== capture.captureId) continue;
      if (!row.statementRowId) throw new Error("Canonical credit-card row is missing");
      db.prepare(`
        INSERT INTO credit_card_capture_entries (
          capture_id, statement_row_id, source_file_id, source_row_index,
          bank, product, card_key, statement_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        capture.captureId,
        row.statementRowId,
        row.sourceFileId,
        row.row.sourceRowIndex,
        row.bank,
        row.product,
        row.cardKey,
        row.statementType,
      );
    }
    for (const file of capture.files) {
      const sourceFileId = sourceFileIdForPath(
        String(file.sourceFileRecord.sourceRelativePath ?? ""),
      );
      for (const cardKey of Object.keys(capture.metadata.cardRowCounts)) {
        const aggregate = db.prepare(`
          SELECT COUNT(*) AS transaction_count, COALESCE(SUM(l.twd_amount), 0) AS total_amount
          FROM credit_card_capture_entries e
          JOIN credit_card_statement_lines l ON l.statement_row_id = e.statement_row_id
          WHERE e.capture_id = ? AND e.card_key = ? AND e.statement_type = ?
        `).get(capture.captureId, cardKey, file.statementType) as {
          transaction_count: number;
          total_amount: number;
        };
        insertRecord(db, "credit_card_snapshots", {
          snapshot_id: hashBytes(stableStringify([
            "credit-card-snapshot", capture.captureId, cardKey, file.statementType,
          ])).slice(0, 32),
          capture_id: capture.captureId,
          source_file_id: sourceFileId,
          bank: capture.bank,
          product: capture.product,
          card_key: cardKey,
          statement_type: file.statementType,
          captured_at: capture.capturedAt,
          as_of_date: capture.capturedAt.slice(0, 10),
          currency: "TWD",
          transaction_count: aggregate.transaction_count,
          total_amount: aggregate.total_amount,
        });
      }
    }
  }
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

export async function importDownloadsCsv(rawInput: Record<string, unknown>) {
  console.log("automation-progress: 0");
  const input = inputSchema.parse(rawInput);
  const downloadsDir = resolve(input.downloadsDir);
  const outputDir = resolve(input.outputDir);
  const sqlitePath = ledgerSqlitePath(outputDir);
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
  console.log("automation-progress: 20");

  try {
    const importedSourceFiles = importedSourceRelativePaths(db);
    const sourceFileRecords: Record<string, unknown>[] = [];
    const statementRows: ImportStatementRow[] = [];
    const fileSummaries: FileImportSummary[] = [];

    let scannedCsvFiles = 0;
    let importedCsvFiles = 0;
    let skippedCsvFiles = 0;
    let importedRows = 0;
    let skippedDuplicateRows = 0;

    for (const sourceFile of await listCsvFiles(downloadsDir)) {
      const context = inferContext(sourceFile, downloadsDir);
      if (!matchesFilters(context, input)) continue;

      activeSourceFile = sourceFile;
      scannedCsvFiles += 1;

      const sourceRelativePath = relative(downloadsDir, sourceFile);
      const allowPathReimport =
        context.bank === "einvoice" && context.product === "personal-invoices";
      if (!allowPathReimport && importedSourceFiles.has(sourceRelativePath)) {
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
        const contentHash = contentHashForRow(context.bank, context.product, rawPayload);
        statementRows.push({
          sourceFileRecord,
          row: {
            sourceRowIndex,
            rawPayload,
            rawRowHash,
            sourceHash,
            contentHash,
          },
        });
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
    console.log("automation-progress: 70");

    if (scannedCsvFiles === 0) {
      throw new Error(
        "No CSV files matched the import filters.",
      );
    }

    const sourceFilesWritten = sourceFileRecords.length;
    const cardRows = parsedCreditCardRows(statementRows);
    const persistedEvidence = persistedCreditCardEvidence(db, sourceFileRecords);
    const allCardRows = [...cardRows, ...persistedEvidence.cardRows];
    const verifiedCaptures = verifiedCreditCardCaptures(
      [...sourceFileRecords, ...persistedEvidence.sourceFileRecords],
      allCardRows,
    );
    const creditCardSourceHashes = new Set(statementRows
      .filter((item) => creditCardParser(item.sourceFileRecord).table === "credit_card_statement_lines")
      .map((item) => item.row.sourceHash));
    let finishedAt = "";
    db.exec("BEGIN");
    try {
      for (const sourceFileRecord of sourceFileRecords) {
        insertSourceFile(db, sourceFileRecord);
      }
      for (const item of statementRows) {
        if (creditCardSourceHashes.has(item.row.sourceHash)) continue;
        activeSourceFile = String(item.sourceFileRecord.sourceFile ?? "");
        const outcome = insertTypedStatementRow(db, item.sourceFileRecord, item.row);
        if (outcome === "duplicate") skippedDuplicateRows += 1;
        else importedRows += 1;
      }
      insertVerifiedCreditCardState(db, allCardRows, verifiedCaptures, startedAt);
      importedRows += cardRows.length;
      finishedAt = new Date().toISOString();
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
        skippedDuplicateRows,
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
        skippedDuplicateRows,
        sourceFilesWritten,
      };
      insertImportRun(db, runRecord);
      insertRunEvent(db, completedEvent);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log("automation-progress: 100");

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
      skippedDuplicateRows,
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

const isCliEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCliEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
