import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { loadSpending, updateSpendingItemCategory } from "./store.ts";

const ledgerDir = mkdtempSync(join(tmpdir(), "spending-store-"));

function insertInvoice(
  db: LedgerDatabase,
  input: {
    invoiceKey: string;
    invoiceId: string;
    status: string;
    amount: number;
    issuedAt?: number | null;
  },
) {
  db.prepare(`
    INSERT INTO personal_invoices (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at, invoice_key,
      issued_at, invoice_id, amount, status, rebated, seller_name
    ) VALUES (?, ?, 'run', 'invoices.csv', 1, ?, ?, ?, 'einvoice',
      'personal-invoices', 'unique', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', ?, ?, ?, ?, ?, 0, ?)
  `).run(
    `row-${input.invoiceKey}`,
    `source-${input.invoiceKey}`,
    `source-hash-${input.invoiceKey}`,
    `raw-hash-${input.invoiceKey}`,
    `content-hash-${input.invoiceKey}`,
    input.invoiceKey,
    input.issuedAt === undefined ? 1769877000 : input.issuedAt,
    input.invoiceId,
    input.amount,
    input.status,
    `${input.status} seller`,
  );
}

function insertItem(
  db: LedgerDatabase,
  input: {
    itemKey: string;
    invoiceKey: string;
    sequence: number;
    paidAmount: number;
    productName: string;
    category: string;
  },
) {
  db.prepare(`
    INSERT INTO personal_invoice_items (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, raw_row_hash, content_hash, bank, product,
      dedupe_status, raw_payload_json, imported_at, created_at, item_key,
      invoice_key, item_sequence_number, item_quantity, item_unit_price,
      item_paid_amount, item_product_name, category
    ) VALUES (?, ?, 'run', 'items.csv', ?, ?, ?, ?, 'einvoice',
      'personal-invoices', 'unique', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    `row-${input.itemKey}`,
    `source-${input.itemKey}`,
    input.sequence,
    `source-hash-${input.itemKey}`,
    `raw-hash-${input.itemKey}`,
    `content-hash-${input.itemKey}`,
    input.itemKey,
    input.invoiceKey,
    input.sequence,
    input.paidAmount,
    input.paidAmount,
    input.productName,
    input.category,
  );
}

try {
  const db = openLedgerDatabase(ledgerDir);
  insertInvoice(db, {
    invoiceKey: "confirmed-invoice",
    invoiceId: "AB12345678",
    status: "confirmed",
    amount: 100,
  });
  insertInvoice(db, {
    invoiceKey: "voided-invoice",
    invoiceId: "CD12345678",
    status: "voided",
    amount: 999,
  });
  insertInvoice(db, {
    invoiceKey: "missing-issued-at-invoice",
    invoiceId: "EF12345678",
    status: "confirmed",
    amount: 50,
    issuedAt: null,
  });
  insertItem(db, {
    itemKey: "confirmed-item-2",
    invoiceKey: "confirmed-invoice",
    sequence: 2,
    paidAmount: 60,
    productName: "Second",
    category: "daily",
  });
  insertItem(db, {
    itemKey: "confirmed-item-1",
    invoiceKey: "confirmed-invoice",
    sequence: 1,
    paidAmount: 40,
    productName: "First",
    category: "food",
  });
  insertItem(db, {
    itemKey: "voided-item",
    invoiceKey: "voided-invoice",
    sequence: 1,
    paidAmount: 999,
    productName: "Excluded",
    category: "shopping",
  });
  db.close();

  const loaded = loadSpending(ledgerDir);
  assert.equal(
    loaded.invoices.some((invoice) => invoice.invoiceKey === "missing-issued-at-invoice"),
    false,
  );
  assert.equal(loaded.invoices.length, 1);
  assert.equal(loaded.invoices[0]?.invoiceKey, "confirmed-invoice");
  assert.deepEqual(loaded.invoices[0]?.items.map((item) => item.itemKey), [
    "confirmed-item-1",
    "confirmed-item-2",
  ]);
  assert.equal(loaded.invoices[0]?.items[0]?.paidAmount, 40);
  assert.equal(Object.hasOwn(loaded.invoices[0] ?? {}, "rawPayloadJson"), false);

  updateSpendingItemCategory({ itemKey: "confirmed-item-2", category: "home" }, ledgerDir);
  assert.equal(loadSpending(ledgerDir).invoices[0]?.items[1]?.category, "home");
  assert.throws(
    () => updateSpendingItemCategory({
      itemKey: "confirmed-item-1",
      category: "invalid" as never,
    }, ledgerDir),
    /Unknown spending category: invalid/,
  );
  assert.throws(
    () => updateSpendingItemCategory({ itemKey: "", category: "food" }, ledgerDir),
    /item key is required/i,
  );
  assert.throws(
    () => updateSpendingItemCategory({ itemKey: "missing", category: "food" }, ledgerDir),
    /No spending item found for key: missing/,
  );
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
