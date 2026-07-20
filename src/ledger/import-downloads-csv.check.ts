import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./db/client.ts";
import { importDownloadsCsv, insertRecord } from "./import-downloads-csv.ts";

const rootDir = await mkdtemp(join(tmpdir(), "einvoice-import-"));
const downloadsDir = join(rootDir, "downloads");
const outputDir = join(rootDir, "ledger");
const sourceDir = join(downloadsDir, "einvoice-personal-invoices");
await mkdir(sourceDir, { recursive: true });

const headers = [
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
  "item_sequence_number",
  "item_quantity",
  "item_unit_price",
  "item_paid_amount",
  "item_product_name",
];

const confirmedRow = {
  carrier_customized_name: "mobile barcode",
  issued_at: "1783065600",
  invoice_id: "AB12345678",
  amount: "129",
  status: "confirmed",
  rebated: "false",
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
  item_sequence_number: "001",
  item_quantity: "2",
  item_unit_price: "50",
  item_paid_amount: "100",
  item_product_name: "咖啡",
};

const transportRow = {
  ...confirmedRow,
  invoice_id: "CD12345678",
  item_sequence_number: "002",
  item_product_name: "Unlabelled item",
  seller_name: "台灣中油股份有限公司",
};

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function csv(rows: Array<Record<string, string>>): string {
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(","))
    .join("\n")}\n`;
}

async function runImport() {
  await importDownloadsCsv({
    downloadsDir,
    outputDir,
    bankFilters: ["einvoice"],
    productFilters: ["personal-invoices"],
  });
}

await writeFile(join(sourceDir, "first.csv"), csv([confirmedRow]), "utf8");
await runImport();

const initialDb = openLedgerDatabase(outputDir, { readOnly: true });
const initialInvoice = initialDb.prepare(
  "SELECT statement_row_id FROM personal_invoices",
).get() as { statement_row_id: string };
const initialItem = initialDb.prepare(
  "SELECT statement_row_id, category FROM personal_invoice_items",
).get() as { statement_row_id: string; category: string };
const initialSourceFile = initialDb.prepare(
  [
    "SELECT import_run_id, source_file_hash, record_json",
    "FROM source_files",
  ].join(" "),
).get() as {
  import_run_id: string;
  source_file_hash: string;
  record_json: string;
};
initialDb.close();

const editableDb = openLedgerDatabase(outputDir);
editableDb.prepare(
  "UPDATE personal_invoice_items SET category = 'shopping' WHERE statement_row_id = ?",
).run(initialItem.statement_row_id);
editableDb.close();

await writeFile(
  join(sourceDir, "first.csv"),
  csv([
    { ...confirmedRow, status: "voided", item_paid_amount: "110" },
    transportRow,
  ]),
  "utf8",
);
await runImport();

const db = openLedgerDatabase(outputDir, { readOnly: true });
const invoiceCount = db.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoices",
).get() as { count: number };
const itemCount = db.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoice_items",
).get() as { count: number };
const sourceFileCount = db.prepare(
  "SELECT COUNT(*) AS count FROM source_files",
).get() as { count: number };
const invoice = db.prepare(
  [
    "SELECT statement_row_id, import_run_id, invoice_id, issued_at, status, rebated,",
    "source_relative_path, raw_payload_json",
    "FROM personal_invoices",
    "WHERE invoice_id = 'AB12345678'",
  ].join(" "),
).get() as {
  statement_row_id: string;
  import_run_id: string;
  invoice_id: string;
  issued_at: number;
  status: string;
  rebated: number;
  source_relative_path: string;
  raw_payload_json: string;
};
const item = db.prepare(
  [
    "SELECT statement_row_id, item_sequence_number,",
    "typeof(item_sequence_number) AS item_sequence_type,",
    "item_product_name, item_paid_amount, category, source_relative_path, raw_payload_json",
    "FROM personal_invoice_items",
    "WHERE item_sequence_number = 1",
  ].join(" "),
).get() as {
  statement_row_id: string;
  item_sequence_number: number;
  item_sequence_type: string;
  item_product_name: string;
  item_paid_amount: number;
  category: string;
  source_relative_path: string;
  raw_payload_json: string;
};
const transportItem = db.prepare(
  "SELECT category FROM personal_invoice_items WHERE item_sequence_number = 2",
).get() as { category: string };
const sourceFile = db.prepare(
  [
    "SELECT import_run_id, source_file_hash, source_relative_path, record_json",
    "FROM source_files",
  ].join(" "),
).get() as {
  import_run_id: string;
  source_file_hash: string;
  source_relative_path: string;
  record_json: string;
};
db.close();

assert.equal(invoiceCount.count, 2);
assert.equal(itemCount.count, 2);
assert.equal(sourceFileCount.count, 1);
assert.notEqual(invoice.statement_row_id, initialInvoice.statement_row_id);
assert.notEqual(item.statement_row_id, initialItem.statement_row_id);
assert.equal(sourceFile.import_run_id, invoice.import_run_id);
assert.notEqual(sourceFile.import_run_id, initialSourceFile.import_run_id);
assert.notEqual(sourceFile.source_file_hash, initialSourceFile.source_file_hash);
assert.notEqual(sourceFile.record_json, initialSourceFile.record_json);
assert.equal(
  sourceFile.source_relative_path,
  "einvoice-personal-invoices/first.csv",
);
assert.match(sourceFile.record_json, /"importRunId":"[^"]+"/);
assert.match(sourceFile.record_json, /"sourceFileHash":"[^"]+"/);
assert.deepEqual(
  {
    ...invoice,
    statement_row_id: "<changed>",
  },
  {
    statement_row_id: "<changed>",
    import_run_id: sourceFile.import_run_id,
    invoice_id: "AB12345678",
    issued_at: 1783065600,
    status: "voided",
    rebated: 0,
    source_relative_path: "einvoice-personal-invoices/first.csv",
    raw_payload_json: JSON.stringify({
      ...confirmedRow,
      status: "voided",
      item_paid_amount: "110",
    }),
  },
);
assert.deepEqual(
  {
    ...item,
    statement_row_id: "<changed>",
  },
  {
    statement_row_id: "<changed>",
    item_sequence_number: 1,
    item_sequence_type: "integer",
    item_product_name: "咖啡",
    item_paid_amount: 110,
    category: "shopping",
    source_relative_path: "einvoice-personal-invoices/first.csv",
    raw_payload_json: JSON.stringify({
      ...confirmedRow,
      status: "voided",
      item_paid_amount: "110",
    }),
  },
);
assert.equal(initialItem.category, "food");
assert.equal(transportItem.category, "transport");

const unchangedRootDir = await mkdtemp(join(tmpdir(), "einvoice-import-unchanged-"));
const unchangedDownloadsDir = join(unchangedRootDir, "downloads");
const unchangedOutputDir = join(unchangedRootDir, "ledger");
const unchangedSourceDir = join(
  unchangedDownloadsDir,
  "einvoice-personal-invoices",
);
await mkdir(unchangedSourceDir, { recursive: true });

await writeFile(join(unchangedSourceDir, "same.csv"), csv([confirmedRow]), "utf8");
await importDownloadsCsv({
  downloadsDir: unchangedDownloadsDir,
  outputDir: unchangedOutputDir,
  bankFilters: ["einvoice"],
  productFilters: ["personal-invoices"],
});
await importDownloadsCsv({
  downloadsDir: unchangedDownloadsDir,
  outputDir: unchangedOutputDir,
  bankFilters: ["einvoice"],
  productFilters: ["personal-invoices"],
});

const unchangedDb = openLedgerDatabase(unchangedOutputDir, { readOnly: true });
const unchangedInvoiceCount = unchangedDb.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoices",
).get() as { count: number };
const unchangedItemCount = unchangedDb.prepare(
  "SELECT COUNT(*) AS count FROM personal_invoice_items",
).get() as { count: number };
const unchangedInvoice = unchangedDb.prepare(
  "SELECT status FROM personal_invoices",
).get() as {
  status: string;
};
const unchangedItem = unchangedDb.prepare(
  "SELECT item_product_name FROM personal_invoice_items",
).get() as {
  item_product_name: string;
};
unchangedDb.close();

assert.equal(unchangedInvoiceCount.count, 1);
assert.equal(unchangedItemCount.count, 1);
assert.deepEqual({ ...unchangedInvoice }, {
  status: "confirmed",
});
assert.deepEqual({ ...unchangedItem }, {
  item_product_name: "咖啡",
});

const sourceHistoryRootDir = await mkdtemp(join(tmpdir(), "source-history-import-"));
const sourceHistoryDownloadsDir = join(sourceHistoryRootDir, "downloads");
const sourceHistoryOutputDir = join(sourceHistoryRootDir, "ledger");
const sourceHistorySourceDir = join(
  sourceHistoryDownloadsDir,
  "fictional-bank",
  "statements",
);
await mkdir(sourceHistorySourceDir, { recursive: true });

const sourceHistoryCsv = (amount: string) => `amount\n${amount}\n`;
const sourceHistoryInput = {
  downloadsDir: sourceHistoryDownloadsDir,
  outputDir: sourceHistoryOutputDir,
  bankFilters: ["fictional"],
  productFilters: ["bank"],
};
const sourceHistoryPath = "fictional-bank/statements/source.csv";
await writeFile(
  join(sourceHistorySourceDir, "source.csv"),
  sourceHistoryCsv("100"),
  "utf8",
);
await importDownloadsCsv(sourceHistoryInput);
await importDownloadsCsv(sourceHistoryInput);

let sourceHistoryDb = openLedgerDatabase(sourceHistoryOutputDir, { readOnly: true });
const sourceFileId = (sourceHistoryDb.prepare(`
  SELECT source_file_id FROM source_files WHERE source_relative_path = ?
`).get(sourceHistoryPath) as { source_file_id: string }).source_file_id;
const sourceImportRuns = sourceHistoryDb.prepare(`
  SELECT import_run_id FROM source_file_imports
  WHERE source_file_id = ? ORDER BY rowid
`).all(sourceFileId) as Array<{ import_run_id: string }>;
assert.equal(sourceHistoryDb.prepare(`
  SELECT COUNT(*) AS count FROM source_file_imports
  WHERE source_file_id = ?
`).get(sourceFileId)?.count, 2);
assert.equal(new Set(sourceImportRuns.map((row) => row.import_run_id)).size, 2);
assert.equal((sourceHistoryDb.prepare(`
  SELECT COUNT(*) AS count FROM unsupported_statement_rows
  WHERE source_file_id = ?
`).get(sourceFileId) as { count: number }).count, 1);
sourceHistoryDb.close();

await writeFile(
  join(sourceHistorySourceDir, "source.csv"),
  sourceHistoryCsv("101"),
  "utf8",
);
await importDownloadsCsv(sourceHistoryInput);

sourceHistoryDb = openLedgerDatabase(sourceHistoryOutputDir, { readOnly: true });
const thirdSourceImport = sourceHistoryDb.prepare(`
  SELECT import_run_id FROM source_file_imports
  WHERE source_file_id = ? ORDER BY rowid DESC LIMIT 1
`).get(sourceFileId) as { import_run_id: string };
const correctedRow = sourceHistoryDb.prepare(`
  SELECT import_run_id FROM unsupported_statement_rows
  WHERE source_file_id = ? AND raw_payload_json = '{"amount":"101"}'
`).get(sourceFileId) as { import_run_id: string };
assert.equal((sourceHistoryDb.prepare(`
  SELECT COUNT(*) AS count FROM source_file_imports
  WHERE source_file_id = ?
`).get(sourceFileId) as { count: number }).count, 3);
assert.equal(correctedRow.import_run_id, thirdSourceImport.import_run_id);
sourceHistoryDb.close();

const sparseRootDir = await mkdtemp(join(tmpdir(), "einvoice-import-sparse-"));
const sparseDownloadsDir = join(sparseRootDir, "downloads");
const sparseOutputDir = join(sparseRootDir, "ledger");
const sparseSourceDir = join(sparseDownloadsDir, "einvoice-personal-invoices");
const sparseHeaders = headers.filter((header) =>
  !["item_product_name", "seller_name", "seller_addr"].includes(header)
);
await mkdir(sparseSourceDir, { recursive: true });
await writeFile(
  join(sparseSourceDir, "missing-classifier-fields.csv"),
  `${sparseHeaders.join(",")}\n${sparseHeaders
    .map((header) => csvCell(confirmedRow[header as keyof typeof confirmedRow] ?? ""))
    .join(",")}\n`,
  "utf8",
);
await importDownloadsCsv({
  downloadsDir: sparseDownloadsDir,
  outputDir: sparseOutputDir,
  bankFilters: ["einvoice"],
  productFilters: ["personal-invoices"],
});

const sparseDb = openLedgerDatabase(sparseOutputDir, { readOnly: true });
const sparseItem = sparseDb.prepare(
  "SELECT category FROM personal_invoice_items",
).get() as { category: string };
sparseDb.close();
assert.equal(sparseItem.category, "other");

const ordinaryRootDir = await mkdtemp(join(tmpdir(), "ordinary-import-"));
const ordinaryDownloadsDir = join(ordinaryRootDir, "downloads");
const ordinaryOutputDir = join(ordinaryRootDir, "ledger");
const ordinarySourceDir = join(ordinaryDownloadsDir, "ctbc-statements");
await mkdir(ordinarySourceDir, { recursive: true });

const accountHeaders = [
  "帳務日期", "交易日期", "交易時間", "摘要",
  "支出金額", "存入金額", "即時餘額", "附註",
];
const accountRow = {
  帳務日期: "2026/07/03",
  交易日期: "2026/07/02",
  交易時間: "09:08:07",
  摘要: "薪資",
  支出金額: "0",
  存入金額: "1234",
  即時餘額: "5678",
  附註: "公司入帳",
};
const accountCsv = (rows: Array<Record<string, string>>) =>
  `${accountHeaders.join(",")}\n${rows
    .map((row) => accountHeaders.map((header) => csvCell(row[header] ?? "")).join(","))
    .join("\n")}\n`;
const ordinaryInput = {
  downloadsDir: ordinaryDownloadsDir,
  outputDir: ordinaryOutputDir,
  bankFilters: ["ctbc"],
  productFilters: ["statements"],
};

await writeFile(join(ordinarySourceDir, "first.csv"), accountCsv([accountRow]), "utf8");
const firstResult = await importDownloadsCsv(ordinaryInput);
await writeFile(
  join(ordinarySourceDir, "second.csv"),
  accountCsv([accountRow, accountRow]),
  "utf8",
);
const secondResult = await importDownloadsCsv(ordinaryInput);

const ordinaryDb = openLedgerDatabase(ordinaryOutputDir, { readOnly: true });
const accountRowCount = ordinaryDb.prepare(
  "SELECT COUNT(*) AS count FROM account_transactions",
).get() as { count: number };
const secondRun = JSON.parse((ordinaryDb.prepare(
  "SELECT record_json FROM import_runs ORDER BY rowid DESC LIMIT 1",
).get() as { record_json: string }).record_json) as Record<string, unknown>;
const secondCompletedEvent = JSON.parse((ordinaryDb.prepare(
  "SELECT record_json FROM import_run_events WHERE event_type = 'completed' ORDER BY rowid DESC LIMIT 1",
).get() as { record_json: string }).record_json) as Record<string, unknown>;
ordinaryDb.close();

assert.equal(firstResult.importedRows, 1);
assert.equal(firstResult.skippedDuplicateRows, 0);
assert.equal(secondResult.importedRows, 0);
assert.equal(secondResult.skippedDuplicateRows, 3);
assert.equal(accountRowCount.count, 1);
assert.equal(secondRun.skippedDuplicateRows, 3);
assert.equal(secondCompletedEvent.skippedDuplicateRows, 3);

const failureRootDir = await mkdtemp(join(tmpdir(), "failed-insert-"));
const failureDb = openLedgerDatabase(failureRootDir);
assert.throws(() => insertRecord(failureDb, "account_transactions", {
  statement_row_id: "invalid-row",
  source_file_id: "invalid-file",
  import_run_id: "invalid-run",
  source_relative_path: "ctbc-statements/invalid.csv",
  source_row_index: 1,
  source_hash: "invalid-source",
  content_hash: "invalid-content",
  bank: "ctbc",
  product: "statements",
  currency: null,
  raw_payload_json: "{}",
  imported_at: "2026-07-12T00:00:00.000Z",
}), /NOT NULL constraint failed: account_transactions.currency/);
const rowsAfterFailedInsert = failureDb.prepare(
  "SELECT COUNT(*) AS count FROM account_transactions",
).get() as { count: number };
assert.equal(rowsAfterFailedInsert.count, 0);
failureDb.close();

const cardHeaders = [
  "statement_period", "card_number", "consume_date", "posting_date",
  "description", "country_currency", "foreign_currency", "foreign_amount",
  "twd_amount", "installment_action", "payment_status",
];
const cardCsv = (rows: Array<Record<string, string>>) =>
  `${cardHeaders.join(",")}\n${rows
    .map((row) => cardHeaders.map((header) => csvCell(row[header] ?? "")).join(","))
    .join("\n")}\n`;
const cardRows = [
  {
    statement_period: "2026-07", card_number: "4000-0000-0000-1111",
    consume_date: "2026-07-01", posting_date: "2026-07-02", description: "Coffee",
    country_currency: "TWD", foreign_currency: "TWD", foreign_amount: "100",
    twd_amount: "100", installment_action: "", payment_status: "unpaid",
  },
  {
    statement_period: "2026-07", card_number: "4000-0000-0000-1111",
    consume_date: "2026-07-03", posting_date: "2026-07-04", description: "Lunch",
    country_currency: "TWD", foreign_currency: "TWD", foreign_amount: "250",
    twd_amount: "250", installment_action: "", payment_status: "unpaid",
  },
  {
    statement_period: "2026-07", card_number: "4000-0000-0000-2222",
    consume_date: "2026-07-05", posting_date: "2026-07-06", description: "Book",
    country_currency: "USD", foreign_currency: "USD", foreign_amount: "15",
    twd_amount: "480", installment_action: "", payment_status: "unpaid",
  },
];

async function cardImportFixture(bank = "esun") {
  const root = await mkdtemp(join(tmpdir(), "card-snapshot-import-"));
  const fixtureDownloadsDir = join(root, "downloads");
  const fixtureOutputDir = join(root, "ledger");
  const fixtureSourceDir = join(fixtureDownloadsDir, `${bank}-credit-card-statements`);
  await mkdir(fixtureSourceDir, { recursive: true });
  const writeCapture = async (
    name: string,
    captureId: string,
    capturedAt: string,
    billedRows: Array<Record<string, string>>,
    unbilledRows: Array<Record<string, string>>,
    writeUnbilled = true,
  ) => {
    const metadata = (rows: Array<Record<string, string>>) => ({
      snapshotMode: "full",
      snapshotCapturedAt: capturedAt,
      captureId,
      capturedAt,
      captureKinds: ["billed", "unbilled"],
      cardRowCounts: { "1111": rows.length },
      completenessEvidence: { bank },
    });
    await writeFile(join(fixtureSourceDir, `${name}-billed.csv`), cardCsv(billedRows), "utf8");
    await writeFile(
      join(fixtureSourceDir, `${name}-billed.json`),
      JSON.stringify(metadata(billedRows)),
      "utf8",
    );
    if (!writeUnbilled) return;
    await writeFile(
      join(fixtureSourceDir, `${name}-unbilled.csv`),
      cardCsv(unbilledRows),
      "utf8",
    );
    await writeFile(
      join(fixtureSourceDir, `${name}-unbilled.json`),
      JSON.stringify(metadata(unbilledRows)),
      "utf8",
    );
  };
  return { fixtureDownloadsDir, fixtureOutputDir, fixtureSourceDir, writeCapture };
}

const repeatedFullCardFixture = await cardImportFixture("fictional");
const repeatedFullCaptureId = "9d000000-0000-4000-8000-000000000006";
await repeatedFullCardFixture.writeCapture(
  "repeat",
  repeatedFullCaptureId,
  "2026-07-17T08:09:10.000Z",
  [cardRows[0]],
  [],
);
const firstRepeatedFullCardResult = await importDownloadsCsv({
  downloadsDir: repeatedFullCardFixture.fixtureDownloadsDir,
  outputDir: repeatedFullCardFixture.fixtureOutputDir,
});
const unchangedRepeatedFullCardResult = await importDownloadsCsv({
  downloadsDir: repeatedFullCardFixture.fixtureDownloadsDir,
  outputDir: repeatedFullCardFixture.fixtureOutputDir,
});
const repeatedFullCardDb = openLedgerDatabase(
  repeatedFullCardFixture.fixtureOutputDir,
  { readOnly: true },
);
assert.equal((repeatedFullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id = ?",
).get(repeatedFullCaptureId) as { count: number }).count, 1);
assert.equal((repeatedFullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id = ?",
).get(repeatedFullCaptureId) as { count: number }).count, 1);
assert.equal((repeatedFullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE capture_id = ?",
).get(repeatedFullCaptureId) as { count: number }).count, 2);
repeatedFullCardDb.close();
assert.equal(firstRepeatedFullCardResult.importedRows, 1);
assert.equal(firstRepeatedFullCardResult.skippedDuplicateRows, 0);
assert.equal(unchangedRepeatedFullCardResult.importedRows, 0);
assert.equal(unchangedRepeatedFullCardResult.skippedDuplicateRows, 1);

await repeatedFullCardFixture.writeCapture(
  "repeat",
  repeatedFullCaptureId,
  "2026-07-17T08:09:10.000Z",
  [{ ...cardRows[0], foreign_amount: "110", twd_amount: "110" }],
  [],
);
const correctedRepeatedFullCardResult = await importDownloadsCsv({
  downloadsDir: repeatedFullCardFixture.fixtureDownloadsDir,
  outputDir: repeatedFullCardFixture.fixtureOutputDir,
});
const correctedRepeatedFullCardDb = openLedgerDatabase(
  repeatedFullCardFixture.fixtureOutputDir,
  { readOnly: true },
);
const correctedCaptureAmount = correctedRepeatedFullCardDb.prepare(`
  SELECT l.twd_amount FROM credit_card_capture_entries AS e
  JOIN credit_card_statement_lines AS l ON l.statement_row_id = e.statement_row_id
  WHERE e.capture_id = ? AND e.statement_type = 'billed'
`).get(repeatedFullCaptureId) as { twd_amount: number };
const correctedSnapshot = correctedRepeatedFullCardDb.prepare(`
  SELECT total_amount FROM credit_card_snapshots
  WHERE capture_id = ? AND statement_type = 'billed'
`).get(repeatedFullCaptureId) as { total_amount: number };
const unchangedCompletedEvent = JSON.parse((correctedRepeatedFullCardDb.prepare(`
  SELECT record_json FROM import_run_events
  WHERE import_run_id = ? AND event_type = 'completed'
`).get(unchangedRepeatedFullCardResult.importRunId) as {
  record_json: string;
}).record_json) as Record<string, unknown>;
const correctedCompletedEvent = JSON.parse((correctedRepeatedFullCardDb.prepare(`
  SELECT record_json FROM import_run_events
  WHERE import_run_id = ? AND event_type = 'completed'
`).get(correctedRepeatedFullCardResult.importRunId) as {
  record_json: string;
}).record_json) as Record<string, unknown>;
correctedRepeatedFullCardDb.close();
assert.equal(correctedRepeatedFullCardResult.importedRows, 1);
assert.equal(correctedRepeatedFullCardResult.skippedDuplicateRows, 0);
assert.equal(correctedCaptureAmount.twd_amount, 110);
assert.equal(correctedSnapshot.total_amount, 110);
assert.equal(unchangedCompletedEvent.importedRows, 0);
assert.equal(unchangedCompletedEvent.skippedDuplicateRows, 1);
assert.equal(correctedCompletedEvent.importedRows, 1);
assert.equal(correctedCompletedEvent.skippedDuplicateRows, 0);

const fullCardFixture = await cardImportFixture();
const firstCaptureId = "9d000000-0000-4000-8000-000000000001";
const secondCaptureId = "9d000000-0000-4000-8000-000000000002";
const partialCaptureId = "9d000000-0000-4000-8000-000000000003";
const mismatchedCaptureId = "9d000000-0000-4000-8000-000000000004";
const identicalCardRows = [cardRows[0], cardRows[0]];
await fullCardFixture.writeCapture(
  "first",
  firstCaptureId,
  "2026-07-12T08:09:10.000Z",
  identicalCardRows,
  [],
);
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
await fullCardFixture.writeCapture(
  "second",
  secondCaptureId,
  "2026-07-13T08:09:10.000Z",
  identicalCardRows,
  [],
);
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
const fullCardDb = openLedgerDatabase(fullCardFixture.fixtureOutputDir, { readOnly: true });
const captureCount = (fullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures",
).get() as { count: number }).count;
assert.equal(captureCount, 2);
const entryRows = fullCardDb.prepare(`
  SELECT l.occurrence_index
  FROM credit_card_capture_entries e
  JOIN credit_card_statement_lines l ON l.statement_row_id = e.statement_row_id
  WHERE e.capture_id = ?
  ORDER BY e.source_row_index
`).all(secondCaptureId) as Array<{ occurrence_index: number }>;
const latestSnapshot = fullCardDb.prepare(`
  SELECT transaction_count, total_amount
  FROM credit_card_snapshots
  WHERE capture_id = ? AND card_key = '1111' AND statement_type = 'billed'
`).get(secondCaptureId) as { transaction_count: number; total_amount: number };
const statementLineCountAfterSecondIdenticalCapture = (fullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_statement_lines",
).get() as { count: number }).count;
const entryCount = (fullCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_capture_entries",
).get() as { count: number }).count;
const latestTransactionTypes = (fullCardDb.prepare(`
  SELECT DISTINCT e.statement_type
  FROM credit_card_capture_entries e
  WHERE e.capture_id = ?
  ORDER BY e.statement_type
`).all(secondCaptureId) as Array<{ statement_type: string }>).map((row) => row.statement_type);
const lastSeenAt = fullCardDb.prepare(`
  SELECT last_seen_at FROM credit_card_statement_lines
  WHERE occurrence_index = 0
`).get() as { last_seen_at: string };
fullCardDb.close();

assert.deepEqual(entryRows.map((row) => row.occurrence_index), [0, 1]);
assert.equal(latestSnapshot.transaction_count, 2);
assert.equal(latestSnapshot.total_amount, 200);
assert.equal(statementLineCountAfterSecondIdenticalCapture, 2);
assert.equal(captureCount, 2);
assert.equal(entryCount, 4);
assert.deepEqual(latestTransactionTypes, ["billed"]);
assert.equal(lastSeenAt.last_seen_at, "2026-07-13T08:09:10.000Z");

const splitCardFixture = await cardImportFixture();
const splitCaptureId = "9d000000-0000-4000-8000-000000000005";
await splitCardFixture.writeCapture(
  "split",
  splitCaptureId,
  "2026-07-16T08:09:10.000Z",
  [cardRows[0]],
  [],
  false,
);
await importDownloadsCsv({
  downloadsDir: splitCardFixture.fixtureDownloadsDir,
  outputDir: splitCardFixture.fixtureOutputDir,
});
await splitCardFixture.writeCapture(
  "split",
  splitCaptureId,
  "2026-07-16T08:09:10.000Z",
  [cardRows[0]],
  [],
);
await importDownloadsCsv({
  downloadsDir: splitCardFixture.fixtureDownloadsDir,
  outputDir: splitCardFixture.fixtureOutputDir,
});
const splitCardDb = openLedgerDatabase(splitCardFixture.fixtureOutputDir, { readOnly: true });
const splitCaptureCount = (splitCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id = ?",
).get(splitCaptureId) as { count: number }).count;
const splitEntryCount = (splitCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id = ?",
).get(splitCaptureId) as { count: number }).count;
const splitSnapshotCount = (splitCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE capture_id = ?",
).get(splitCaptureId) as { count: number }).count;
splitCardDb.close();
assert.equal(splitCaptureCount, 1);
assert.equal(splitEntryCount, 1);
assert.equal(splitSnapshotCount, 2);

await fullCardFixture.writeCapture(
  "partial",
  partialCaptureId,
  "2026-07-14T08:09:10.000Z",
  [{ ...cardRows[0], description: "Partial only" }],
  [],
  false,
);
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
await fullCardFixture.writeCapture(
  "mismatched",
  mismatchedCaptureId,
  "2026-07-15T08:09:10.000Z",
  [{ ...cardRows[0], description: "Mismatched metadata" }],
  [],
);
await writeFile(
  join(fullCardFixture.fixtureSourceDir, "mismatched-unbilled.json"),
  JSON.stringify({
    snapshotMode: "full",
    captureId: mismatchedCaptureId,
    capturedAt: "2026-07-15T08:09:10.000Z",
    captureKinds: ["billed", "unbilled"],
    cardRowCounts: { "2222": 0 },
    completenessEvidence: { bank: "esun" },
  }),
  "utf8",
);
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
await writeFile(
  join(fullCardFixture.fixtureSourceDir, "invalid-billed.csv"),
  cardCsv([{ ...cardRows[0], description: "Invalid metadata evidence" }]),
  "utf8",
);
await writeFile(
  join(fullCardFixture.fixtureSourceDir, "invalid-billed.json"),
  "{not json",
  "utf8",
);
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
const partialCardDb = openLedgerDatabase(fullCardFixture.fixtureOutputDir, { readOnly: true });
const partialCaptureCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id = ?",
).get(partialCaptureId) as { count: number }).count;
const partialEntryCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_capture_entries WHERE capture_id = ?",
).get(partialCaptureId) as { count: number }).count;
const partialSnapshotCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_snapshots WHERE capture_id = ?",
).get(partialCaptureId) as { count: number }).count;
const mismatchedCaptureCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures WHERE capture_id = ?",
).get(mismatchedCaptureId) as { count: number }).count;
const partialCanonicalCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_statement_lines WHERE description = 'Partial only'",
).get() as { count: number }).count;
const invalidSourceFileCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM source_files WHERE source_relative_path = 'esun-credit-card-statements/invalid-billed.csv'",
).get() as { count: number }).count;
const invalidCanonicalCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_statement_lines WHERE description = 'Invalid metadata evidence'",
).get() as { count: number }).count;
const verifiedCaptureCount = (partialCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_captures",
).get() as { count: number }).count;
partialCardDb.close();
assert.equal(partialCaptureCount, 0);
assert.equal(partialEntryCount, 0);
assert.equal(partialSnapshotCount, 0);
assert.equal(mismatchedCaptureCount, 0);
assert.equal(partialCanonicalCount, 1);
assert.equal(invalidSourceFileCount, 1);
assert.equal(invalidCanonicalCount, 1);
assert.equal(verifiedCaptureCount, 2);
