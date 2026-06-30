import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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

function importedContentHashes(db: LedgerDatabase): Set<string> {
  const hashes = new Set<string>();
  for (const table of TYPED_STATEMENT_TABLES) {
    const rows = db
      .prepare(`SELECT content_hash FROM ${table}`)
      .all() as Array<{ content_hash: string }>;
    for (const row of rows) hashes.add(row.content_hash);
  }
  return hashes;
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

async function importDownloadsCsv(rawInput: Record<string, unknown>) {
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
    const contentHashes = importedContentHashes(db);
    const sourceFileRecords: Record<string, unknown>[] = [];
    const statementRows: Array<{
      sourceFileRecord: Record<string, unknown>;
      row: {
        sourceRowIndex: number;
        rawPayload: Record<string, string>;
        rawRowHash: string;
        sourceHash: string;
        contentHash: string;
        dedupeStatus: "unique" | "duplicate";
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
        const contentHash = contentHashForRow(context.bank, context.product, rawPayload);
        const dedupeStatus = contentHashes.has(contentHash) ? "duplicate" : "unique";
        contentHashes.add(contentHash);
        statementRows.push({
          sourceFileRecord,
          row: {
            sourceRowIndex,
            rawPayload,
            rawRowHash,
            sourceHash,
            contentHash,
            dedupeStatus,
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
    console.log("automation-progress: 70");

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
