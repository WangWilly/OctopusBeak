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
assert.equal(secondResult.skippedDuplicateRows, 2);
assert.equal(accountRowCount.count, 1);
assert.equal(secondRun.skippedDuplicateRows, 2);
assert.equal(secondCompletedEvent.skippedDuplicateRows, 2);

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

async function cardImportFixture(metadata: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "card-snapshot-import-"));
  const fixtureDownloadsDir = join(root, "downloads");
  const fixtureOutputDir = join(root, "ledger");
  const fixtureSourceDir = join(fixtureDownloadsDir, "esun-credit-card-statements");
  await mkdir(fixtureSourceDir, { recursive: true });
  await writeFile(join(fixtureSourceDir, "billed.csv"), cardCsv(cardRows), "utf8");
  await writeFile(join(fixtureSourceDir, "billed.json"), JSON.stringify(metadata), "utf8");
  return { fixtureDownloadsDir, fixtureOutputDir };
}

const fullCardFixture = await cardImportFixture({
  snapshotMode: "full",
  snapshotCapturedAt: "2026-07-12T08:09:10.000Z",
  cardRowCounts: { "1111": 2, "2222": 1, "3333": 0 },
});
await importDownloadsCsv({
  downloadsDir: fullCardFixture.fixtureDownloadsDir,
  outputDir: fullCardFixture.fixtureOutputDir,
});
const fullCardDb = openLedgerDatabase(fullCardFixture.fixtureOutputDir, { readOnly: true });
const snapshots = (fullCardDb.prepare([
  "SELECT s.source_file_id, f.source_file_id AS expected_source_file_id,",
  "s.card_key, s.statement_type, s.captured_at, s.as_of_date, s.currency,",
  "s.transaction_count, s.total_amount",
  "FROM credit_card_snapshots s JOIN source_files f ON f.source_file_id = s.source_file_id",
  "ORDER BY s.card_key",
].join(" ")).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
const semanticKeyCount = fullCardDb.prepare(
  "SELECT COUNT(semantic_key) AS count FROM credit_card_statement_lines",
).get() as { count: number };
fullCardDb.close();
assert.deepEqual(snapshots, [
  {
    source_file_id: snapshots[0]?.source_file_id,
    expected_source_file_id: snapshots[0]?.source_file_id,
    card_key: "1111", statement_type: "billed",
    captured_at: "2026-07-12T08:09:10.000Z", as_of_date: "2026-07-12",
    currency: "TWD", transaction_count: 2, total_amount: 350,
  },
  {
    source_file_id: snapshots[1]?.source_file_id,
    expected_source_file_id: snapshots[1]?.source_file_id,
    card_key: "2222", statement_type: "billed",
    captured_at: "2026-07-12T08:09:10.000Z", as_of_date: "2026-07-12",
    currency: "TWD", transaction_count: 1, total_amount: 480,
  },
  {
    source_file_id: snapshots[2]?.source_file_id,
    expected_source_file_id: snapshots[2]?.source_file_id,
    card_key: "3333", statement_type: "billed",
    captured_at: "2026-07-12T08:09:10.000Z", as_of_date: "2026-07-12",
    currency: "TWD", transaction_count: 0, total_amount: 0,
  },
]);
assert.equal(semanticKeyCount.count, 3);

const legacyCardFixture = await cardImportFixture({ cardRowCounts: { "1111": 2, "2222": 1 } });
await importDownloadsCsv({
  downloadsDir: legacyCardFixture.fixtureDownloadsDir,
  outputDir: legacyCardFixture.fixtureOutputDir,
});
const legacyCardDb = openLedgerDatabase(legacyCardFixture.fixtureOutputDir, { readOnly: true });
assert.equal((legacyCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_snapshots",
).get() as { count: number }).count, 0);
legacyCardDb.close();

const malformedCardFixture = await cardImportFixture({
  snapshotMode: "full",
  cardRowCounts: { "1111": 2, "2222": 1 },
});
await assert.rejects(() => importDownloadsCsv({
  downloadsDir: malformedCardFixture.fixtureDownloadsDir,
  outputDir: malformedCardFixture.fixtureOutputDir,
}), /snapshotCapturedAt/);
const malformedCardDb = openLedgerDatabase(malformedCardFixture.fixtureOutputDir, { readOnly: true });
assert.equal((malformedCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_statement_lines",
).get() as { count: number }).count, 0);
assert.equal((malformedCardDb.prepare(
  "SELECT COUNT(*) AS count FROM credit_card_snapshots",
).get() as { count: number }).count, 0);
malformedCardDb.close();

for (const invalidCardKey of ["", "111", "card-1111"]) {
  const invalidCardKeyFixture = await cardImportFixture({
    snapshotMode: "full",
    snapshotCapturedAt: "2026-07-12T08:09:10.000Z",
    cardRowCounts: { [invalidCardKey]: 2, "2222": 1 },
  });
  await assert.rejects(() => importDownloadsCsv({
    downloadsDir: invalidCardKeyFixture.fixtureDownloadsDir,
    outputDir: invalidCardKeyFixture.fixtureOutputDir,
  }), /cardRowCounts/);
  const invalidCardKeyDb = openLedgerDatabase(
    invalidCardKeyFixture.fixtureOutputDir,
    { readOnly: true },
  );
  assert.equal((invalidCardKeyDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_statement_lines",
  ).get() as { count: number }).count, 0);
  assert.equal((invalidCardKeyDb.prepare(
    "SELECT COUNT(*) AS count FROM credit_card_snapshots",
  ).get() as { count: number }).count, 0);
  invalidCardKeyDb.close();
}
