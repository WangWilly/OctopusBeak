import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import XLSX from "xlsx";
import { z } from "zod";

const inputSchema = z.object({
  downloadsDir: z.string().default("downloads"),
  outputDir: z.string().default("data/ledger"),
  bankFilters: z.array(z.string()).default([]),
  productFilters: z.array(z.string()).default([]),
  dedupeMode: z.enum(["all", "none"]).default("all"),
  dryRun: z.boolean().default(false),
  allowEmpty: z.boolean().default(false),
});

type Input = z.infer<typeof inputSchema>;
type DedupeStatus = "unique" | "duplicate";
type RecordType =
  | "import_batch"
  | "import_result"
  | "import_run"
  | "import_run_event"
  | "raw_transaction_occurrence";

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

type CsvLayoutStrategy =
  | "first-row-header"
  | "detected-header-row"
  | "empty-or-metadata";

type CsvLayoutDetectionSource =
  | "known-header"
  | "generated-column-header"
  | "heuristic"
  | "none";

type CsvLayout = {
  strategy: CsvLayoutStrategy;
  detectionSource: CsvLayoutDetectionSource;
  headerRowIndex: number | null;
  headerRowNumber: number | null;
  dataStartRowIndex: number | null;
  dataStartRowNumber: number | null;
  preambleRowCount: number;
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
  uniqueRows: number;
  duplicateRows: number;
  relatedRawFiles: string[];
  relatedRawFileRelativePaths: string[];
  relatedRawFileMetadata: FileMetadata[];
};

const RAW_FILE_EXTENSIONS = [".xls", ".xlsx", ".json"];
const RAW_LEDGER_SCHEMA_VERSION = "raw-ledger.v1";
const IMPORTER_NAME = "import-downloads-csv";
const IMPORTER_VERSION = "1";

const KNOWN_HEADER_HINTS = [
  {
    bank: "fubon",
    product: "statements",
    requiredHeaders: ["帳務日期", "交易時間", "摘要", "即時餘額"],
  },
  {
    bank: "fubon",
    product: "loan-statements",
    requiredHeaders: ["交易日期", "交易內容", "異動金額", "餘額"],
  },
  {
    bank: "fubon",
    product: "loan-statements",
    requiredHeaders: ["交易日期", "本金", "利息", "違約金"],
  },
];

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function relatedRawFiles(csvFile: string): Promise<string[]> {
  const basePath = csvFile.slice(0, -4);
  const related: string[] = [];

  for (const ext of RAW_FILE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (await fileExists(candidate)) {
      related.push(candidate);
    }
  }

  return related;
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

async function buildRelatedRawFileMetadata(
  paths: string[],
  downloadsDir: string,
): Promise<FileMetadata[]> {
  const metadata: FileMetadata[] = [];

  for (const path of paths) {
    metadata.push(await fileMetadata(path, downloadsDir));
  }

  return metadata;
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

async function loadKnownSourceHashes(path: string): Promise<Set<string>> {
  if (!(await fileExists(path))) return new Set();

  const hashes = new Set<string>();
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as { sourceHash?: unknown };
      if (typeof parsed.sourceHash === "string") {
        hashes.add(parsed.sourceHash);
      }
    } catch {
      // Ignore partial or manually edited JSONL lines.
    }
  }

  return hashes;
}

function nonEmptyCells(row: unknown[]): string[] {
  return row.map(normalizeCell).filter((value) => value !== "");
}

function hasAnyCell(row: unknown[]): boolean {
  return nonEmptyCells(row).length > 0;
}

function isGeneratedColumnHeaderRow(row: unknown[]): boolean {
  const cells = row.map(normalizeHeader).filter(Boolean);
  return (
    cells.length >= 2 &&
    cells.every((value, index) => value === `column_${index + 1}`)
  );
}

function emptyCsvLayout(warnings: string[]): CsvLayout {
  return {
    strategy: "empty-or-metadata",
    detectionSource: "none",
    headerRowIndex: null,
    headerRowNumber: null,
    dataStartRowIndex: null,
    dataStartRowNumber: null,
    preambleRowCount: 0,
    warnings,
  };
}

function looksLikeDataValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return (
    /^\d{4}-\d{1,2}-\d{1,2}/.test(trimmed) ||
    /^\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?$/.test(trimmed) ||
    /^-?[\d,]+(\.\d+)?$/.test(trimmed) ||
    /^[\d\s*()（）-]{8,}$/.test(trimmed)
  );
}

function findKnownHeaderRow(
  matrix: unknown[][],
  context: SourceContext,
): number | null {
  const hints = KNOWN_HEADER_HINTS.filter(
    (candidate) =>
      candidate.bank === context.bank && candidate.product === context.product,
  );
  if (hints.length === 0) return null;

  for (const [index, row] of matrix.entries()) {
    const cells = row.map(normalizeHeader).filter(Boolean);
    if (
      hints.some((hint) =>
        hint.requiredHeaders.every((header) => cells.includes(header)),
      ) &&
      matrix.slice(index + 1).some(hasAnyCell)
    ) {
      return index;
    }
  }

  return null;
}

function scoreHeaderCandidate(matrix: unknown[][], rowIndex: number): number {
  const cells = matrix[rowIndex].map(normalizeHeader).filter(Boolean);
  if (cells.length < 2) return Number.NEGATIVE_INFINITY;

  const followingRows = matrix
    .slice(rowIndex + 1)
    .filter(hasAnyCell)
    .slice(0, 5);
  if (followingRows.length === 0) return Number.NEGATIVE_INFINITY;

  const uniqueCellCount = new Set(cells).size;
  const nextDataLikeRows = followingRows.filter((row) => {
    const nonEmptyCount = nonEmptyCells(row).length;
    return nonEmptyCount >= Math.min(2, cells.length);
  }).length;
  const textLikeHeaderCells = cells.filter(
    (value) => !looksLikeDataValue(value),
  );

  return (
    cells.length * 5 +
    nextDataLikeRows * 8 +
    textLikeHeaderCells.length * 2 +
    (uniqueCellCount === cells.length ? 4 : -4) +
    (rowIndex === 0 ? 2 : 0) -
    Math.min(rowIndex, 20) * 0.25
  );
}

function detectCsvLayout(
  matrix: unknown[][],
  context: SourceContext,
): CsvLayout {
  const nonEmptyRowCount = matrix.filter(hasAnyCell).length;
  if (matrix.length < 2 || nonEmptyRowCount < 2) {
    return emptyCsvLayout([
      "CSV has fewer than two non-empty rows; treated as empty or metadata-only.",
    ]);
  }

  if (isGeneratedColumnHeaderRow(matrix[0])) {
    return {
      strategy: "first-row-header",
      detectionSource: "generated-column-header",
      headerRowIndex: 0,
      headerRowNumber: 1,
      dataStartRowIndex: 1,
      dataStartRowNumber: 2,
      preambleRowCount: 0,
      warnings: [
        "First row contains generated column_N headers; rows are preserved with positional column names.",
      ],
    };
  }

  const knownHeaderRow = findKnownHeaderRow(matrix, context);
  if (knownHeaderRow !== null) {
    return {
      strategy:
        knownHeaderRow === 0 ? "first-row-header" : "detected-header-row",
      detectionSource: "known-header",
      headerRowIndex: knownHeaderRow,
      headerRowNumber: knownHeaderRow + 1,
      dataStartRowIndex: knownHeaderRow + 1,
      dataStartRowNumber: knownHeaderRow + 2,
      preambleRowCount: knownHeaderRow,
      warnings:
        knownHeaderRow === 0
          ? []
          : [
              `Detected ${knownHeaderRow} preamble row(s) before the CSV header.`,
            ],
    };
  }

  let bestRowIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < matrix.length; index += 1) {
    const score = scoreHeaderCandidate(matrix, index);
    if (score > bestScore) {
      bestScore = score;
      bestRowIndex = index;
    }
  }

  if (bestRowIndex === null || bestScore === Number.NEGATIVE_INFINITY) {
    return emptyCsvLayout(["No usable header row was detected."]);
  }

  return {
    strategy: bestRowIndex === 0 ? "first-row-header" : "detected-header-row",
    detectionSource: "heuristic",
    headerRowIndex: bestRowIndex,
    headerRowNumber: bestRowIndex + 1,
    dataStartRowIndex: bestRowIndex + 1,
    dataStartRowNumber: bestRowIndex + 2,
    preambleRowCount: bestRowIndex,
    warnings:
      bestRowIndex === 0
        ? []
        : [`Detected ${bestRowIndex} preamble row(s) before the CSV header.`],
  };
}

function parseCsvRows(csvText: string, context: SourceContext): ParsedCsv {
  const workbook = XLSX.read(csvText, { raw: false, type: "string" });
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
      raw: false,
    },
  );
  const csvLayout = detectCsvLayout(matrix, context);
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
  sourceFileHash: string,
  sourceRowIndex: number,
  rawRowHash: string,
): string {
  return hashBytes(
    stableStringify({ sourceFileHash, sourceRowIndex, rawRowHash }),
  );
}

async function importDownloadsCsv(rawInput: Record<string, unknown>) {
  const input = inputSchema.parse(rawInput);
  const downloadsDir = resolve(input.downloadsDir);
  const outputDir = resolve(input.outputDir);
  const batchLogPath = join(outputDir, "import_batches.jsonl");
  const transactionLogPath = join(
    outputDir,
    "raw_transaction_occurrences.jsonl",
  );
  const runLogPath = join(outputDir, "import_runs.jsonl");
  const runEventLogPath = join(outputDir, "import_run_events.jsonl");
  const importRunId = randomUUID();
  const startedAt = new Date().toISOString();
  let activeSourceFile: string | null = null;

  if (!input.dryRun) {
    await mkdir(outputDir, { recursive: true });
    await appendFile(
      runEventLogPath,
      `${JSON.stringify({
        ...baseRecord("import_run_event"),
        importRunId,
        eventType: "started",
        eventAt: startedAt,
        downloadsDir,
        outputDir,
        bankFilters: input.bankFilters,
        productFilters: input.productFilters,
        dedupeMode: input.dedupeMode,
        allowEmpty: input.allowEmpty,
      })}\n`,
      "utf8",
    );
  }

  try {
    const knownSourceHashes =
      input.dedupeMode === "all"
        ? await loadKnownSourceHashes(transactionLogPath)
        : new Set<string>();
    const seenInRun = new Set<string>();
    const batchLines: string[] = [];
    const transactionLines: string[] = [];
    const fileSummaries: FileImportSummary[] = [];

    let scannedCsvFiles = 0;
    let importedRows = 0;
    let uniqueRows = 0;
    let duplicateRows = 0;

    for (const sourceFile of await listCsvFiles(downloadsDir)) {
      const context = inferContext(sourceFile, downloadsDir);
      if (!matchesFilters(context, input)) continue;

      activeSourceFile = sourceFile;
      scannedCsvFiles += 1;

      const sourceRelativePath = relative(downloadsDir, sourceFile);
      const fileBuffer = await readFile(sourceFile);
      const sourceFileHash = hashBytes(fileBuffer);
      const parsedCsv = parseCsvRows(fileBuffer.toString("utf8"), context);
      const { sourceSheetName, csvLayout, headers, recordKeys, rows } =
        parsedCsv;
      const sourceFileStat = await stat(sourceFile);
      const sourceFileMetadata = await fileMetadata(sourceFile, downloadsDir);
      const importBatchId = randomUUID();
      const relatedRawFilePaths = await relatedRawFiles(sourceFile);
      const relatedRawFileRelativePaths = relatedRawFilePaths.map((path) =>
        relative(downloadsDir, path),
      );
      const relatedRawFileMetadata = await buildRelatedRawFileMetadata(
        relatedRawFilePaths,
        downloadsDir,
      );
      let fileUniqueRows = 0;
      let fileDuplicateRows = 0;

      batchLines.push(
        JSON.stringify({
          ...baseRecord("import_batch"),
          importRunId,
          importBatchId,
          sourceFile,
          sourceRelativePath,
          sourceFileMetadata,
          sourceFileHash,
          sourceFileBytes: sourceFileStat.size,
          sourceFileModifiedAt: sourceFileStat.mtime.toISOString(),
          importedAt: startedAt,
          status: "completed",
          relatedRawFiles: relatedRawFilePaths,
          relatedRawFileRelativePaths,
          relatedRawFileMetadata,
          bank: context.bank,
          product: context.product,
          sourceSheetName,
          csvLayout,
          headers,
          recordKeys,
          rowCount: rows.length,
        }),
      );

      for (const row of rows) {
        const { sourceRowIndex, rawPayload } = row;
        const rawRowHash = hashBytes(stableStringify(rawPayload));
        const sourceHash = sourceHashForOccurrence(
          sourceFileHash,
          sourceRowIndex,
          rawRowHash,
        );
        const contentHash = contentHashForRow(
          context.bank,
          context.product,
          rawPayload,
        );
        const isDuplicate =
          input.dedupeMode === "all" &&
          (knownSourceHashes.has(sourceHash) || seenInRun.has(sourceHash));
        const dedupeStatus: DedupeStatus = isDuplicate
          ? "duplicate"
          : "unique";

        if (isDuplicate) {
          duplicateRows += 1;
          fileDuplicateRows += 1;
        } else {
          uniqueRows += 1;
          fileUniqueRows += 1;
          seenInRun.add(sourceHash);
        }

        transactionLines.push(
          JSON.stringify({
            ...baseRecord("raw_transaction_occurrence"),
            importRunId,
            rawTransactionId: randomUUID(),
            importBatchId,
            sourceFile,
            sourceRelativePath,
            sourceRowIndex,
            sourceHash,
            rawRowHash,
            contentHash,
            bank: context.bank,
            product: context.product,
            dedupeStatus,
            sourceFileHash,
            rawPayload,
          }),
        );
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
        uniqueRows: fileUniqueRows,
        duplicateRows: fileDuplicateRows,
        relatedRawFiles: relatedRawFilePaths,
        relatedRawFileRelativePaths,
        relatedRawFileMetadata,
      });

      for (const row of rows) {
        const { sourceRowIndex, rawPayload } = row;
        const rawRowHash = hashBytes(stableStringify(rawPayload));
        knownSourceHashes.add(
          sourceHashForOccurrence(sourceFileHash, sourceRowIndex, rawRowHash),
        );
      }
    }

    if (!input.dryRun && !input.allowEmpty && scannedCsvFiles === 0) {
      throw new Error(
        "No CSV files matched the import filters. Re-run with dryRun=true to inspect the scan or allowEmpty=true to record an empty import run.",
      );
    }

    if (!input.dryRun && batchLines.length > 0) {
      await appendFile(batchLogPath, `${batchLines.join("\n")}\n`, "utf8");
    }
    if (!input.dryRun && transactionLines.length > 0) {
      await appendFile(
        transactionLogPath,
        `${transactionLines.join("\n")}\n`,
        "utf8",
      );
    }
    const finishedAt = new Date().toISOString();
    const batchesWritten = input.dryRun ? 0 : batchLines.length;

    if (!input.dryRun) {
      await appendFile(
        runLogPath,
        `${JSON.stringify({
          ...baseRecord("import_run"),
          importRunId,
          startedAt,
          finishedAt,
          downloadsDir,
          outputDir,
          bankFilters: input.bankFilters,
          productFilters: input.productFilters,
          dedupeMode: input.dedupeMode,
          dryRun: input.dryRun,
          allowEmpty: input.allowEmpty,
          scannedCsvFiles,
          importedRows,
          uniqueRows,
          duplicateRows,
          batchesWritten,
          runEventLogPath,
          batchLogPath,
          transactionLogPath,
        })}\n`,
        "utf8",
      );
      await appendFile(
        runEventLogPath,
        `${JSON.stringify({
          ...baseRecord("import_run_event"),
          importRunId,
          eventType: "completed",
          eventAt: finishedAt,
          scannedCsvFiles,
          importedRows,
          uniqueRows,
          duplicateRows,
          batchesWritten,
        })}\n`,
        "utf8",
      );
    }

    return {
      ...baseRecord("import_result"),
      importRunId,
      startedAt,
      finishedAt,
      downloadsDir,
      dryRun: input.dryRun,
      allowEmpty: input.allowEmpty,
      scannedCsvFiles,
      importedRows,
      uniqueRows,
      duplicateRows,
      batchesWritten,
      runLogPath,
      runEventLogPath,
      batchLogPath,
      transactionLogPath,
      files: fileSummaries,
    };
  } catch (error) {
    if (!input.dryRun) {
      await appendFile(
        runEventLogPath,
        `${JSON.stringify({
          ...baseRecord("import_run_event"),
          importRunId,
          eventType: "failed",
          eventAt: new Date().toISOString(),
          activeSourceFile,
          errorName: error instanceof Error ? error.name : "Error",
          errorMessage: error instanceof Error ? error.message : String(error),
        })}\n`,
        "utf8",
      );
    }
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
