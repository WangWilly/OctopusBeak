import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { buildSpendingModel } from "../model.ts";
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
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, invoice_key,
      issued_at, invoice_id, amount, status, rebated, seller_name
    ) VALUES (?, ?, 'run', 'invoices.csv', 1, ?, ?, 'einvoice',
      'personal-invoices', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', ?, ?, ?, ?, ?, 0, ?)
  `).run(
    `row-${input.invoiceKey}`,
    `source-${input.invoiceKey}`,
    `source-hash-${input.invoiceKey}`,
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
    sequence: number | null;
    paidAmount: number;
    productName: string;
    category: string;
  },
) {
  db.prepare(`
    INSERT INTO personal_invoice_items (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, item_key,
      invoice_key, item_sequence_number, item_quantity, item_unit_price,
      item_paid_amount, item_product_name, category
    ) VALUES (?, ?, 'run', 'items.csv', ?, ?, ?, 'einvoice',
      'personal-invoices', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    `row-${input.itemKey}`,
    `source-${input.itemKey}`,
    input.sequence ?? 0,
    `source-hash-${input.itemKey}`,
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
  insertInvoice(db, {
    invoiceKey: "legacy-null-sequence-invoice",
    invoiceId: "GH12345678",
    status: "confirmed",
    amount: 5,
  });
  insertItem(db, {
    itemKey: "confirmed-item-b",
    invoiceKey: "confirmed-invoice",
    sequence: 1,
    paidAmount: 20,
    productName: "Tied B",
    category: "daily",
  });
  insertItem(db, {
    itemKey: "confirmed-item-a",
    invoiceKey: "confirmed-invoice",
    sequence: 1,
    paidAmount: 30,
    productName: "Tied A",
    category: "food",
  });
  insertItem(db, {
    itemKey: "confirmed-item-2",
    invoiceKey: "confirmed-invoice",
    sequence: 2,
    paidAmount: 40,
    productName: "Second",
    category: "home",
  });
  insertItem(db, {
    itemKey: "legacy-null-sequence-item",
    invoiceKey: "legacy-null-sequence-invoice",
    sequence: null,
    paidAmount: 5,
    productName: "Legacy",
    category: "other",
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
  assert.equal(loaded.invoices.length, 2);
  const confirmedInvoice = loaded.invoices.find(
    (invoice) => invoice.invoiceKey === "confirmed-invoice",
  );
  assert.deepEqual(confirmedInvoice?.items.map((item) => item.itemKey), [
    "confirmed-item-a",
    "confirmed-item-b",
    "confirmed-item-2",
  ]);
  assert.deepEqual(confirmedInvoice?.items.map((item) => item.sequence), [1, 1, 2]);
  assert.equal(
    loaded.invoices.find((invoice) => invoice.invoiceKey === "legacy-null-sequence-invoice")
      ?.items[0]?.sequence,
    null,
  );
  assert.deepEqual(buildSpendingModel(confirmedInvoice ? [confirmedInvoice] : []).monthlyRows, [{
    month: "2026-02",
    total: 100,
    food: 40,
    daily: 20,
    transport: 0,
    shopping: 0,
    home: 40,
    leisure: 0,
    other: 0,
  }]);
  assert.equal(Object.hasOwn(confirmedInvoice ?? {}, "rawPayloadJson"), false);

  updateSpendingItemCategory({ itemKey: "confirmed-item-2", category: "leisure" }, ledgerDir);
  assert.equal(
    loadSpending(ledgerDir).invoices.find((invoice) => invoice.invoiceKey === "confirmed-invoice")
      ?.items[2]?.category,
    "leisure",
  );
  assert.throws(
    () => updateSpendingItemCategory({
      itemKey: "confirmed-item-a",
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
