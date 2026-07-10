import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./db/client.ts";
import { importDownloadsCsv } from "./import-downloads-csv.ts";

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
  "SELECT status, dedupe_status FROM personal_invoices",
).get() as {
  status: string;
  dedupe_status: string;
};
const unchangedItem = unchangedDb.prepare(
  "SELECT item_product_name, dedupe_status FROM personal_invoice_items",
).get() as {
  item_product_name: string;
  dedupe_status: string;
};
unchangedDb.close();

assert.equal(unchangedInvoiceCount.count, 1);
assert.equal(unchangedItemCount.count, 1);
assert.deepEqual({ ...unchangedInvoice }, {
  status: "confirmed",
  dedupe_status: "unique",
});
assert.deepEqual({ ...unchangedItem }, {
  item_product_name: "咖啡",
  dedupe_status: "unique",
});
