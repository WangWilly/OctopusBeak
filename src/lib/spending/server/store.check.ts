import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import {
  loadSpending,
  updateSpendingItemCategory,
  updateSpendingTransactionOverride,
} from "./store.ts";

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

function insertAccountTransaction(
  db: LedgerDatabase,
  input: {
    statementRowId: string;
    accountNumber: string;
    date: string;
    transactionTime?: string;
    description: string;
    note?: string;
    withdrawalAmount?: number;
    depositAmount?: number;
  },
) {
  db.prepare(`
    INSERT INTO account_transactions (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, account_number, currency,
      transaction_date, transaction_time, description, note,
      withdrawal_amount, deposit_amount
    ) VALUES (?, ?, 'run', 'account.csv', 1, ?, ?, 'test-bank',
      'account-transactions', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', ?, 'TWD', ?, ?, ?, ?, ?, ?)
  `).run(
    input.statementRowId,
    `source-${input.statementRowId}`,
    `source-hash-${input.statementRowId}`,
    `content-hash-${input.statementRowId}`,
    input.accountNumber,
    input.date,
    input.transactionTime ?? null,
    input.description,
    input.note ?? null,
    input.withdrawalAmount ?? null,
    input.depositAmount ?? null,
  );
}

function insertCardStatementLine(db: LedgerDatabase, statementRowId: string, amount: number) {
  db.prepare(`
    INSERT INTO credit_card_statement_lines (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product,
      raw_payload_json, imported_at, created_at, statement_type,
      consume_date, description, twd_amount
    ) VALUES (?, ?, 'run', 'card.csv', 1, ?, ?, 'test-bank',
      'credit-card-statements', '{}', '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z', 'billed', '2026-02-01',
      '信用卡繳款', ?)
  `).run(
    statementRowId,
    `source-${statementRowId}`,
    `source-hash-${statementRowId}`,
    `content-hash-${statementRowId}`,
    amount,
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
  insertAccountTransaction(db, {
    statementRowId: "mirrored-transfer",
    accountNumber: "111",
    date: "2026-02-01",
    transactionTime: "17:27:28",
    description: "轉帳",
    note: "06600000102281740 7097230279900200",
    withdrawalAmount: 200,
  });
  insertAccountTransaction(db, {
    statementRowId: "counterpart-deposit",
    accountNumber: "222",
    date: "2026-02-02",
    description: "轉入",
    depositAmount: 200,
  });
  insertAccountTransaction(db, {
    statementRowId: "card-payment",
    accountNumber: "111",
    date: "2026-02-02",
    description: "自動扣款",
    withdrawalAmount: 300,
  });
  insertCardStatementLine(db, "card-purchase-line", 200);
  insertCardStatementLine(db, "card-payment-line", -300);
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
  assert.deepEqual(loaded.monthlyRows, [{
    month: "2026-02",
    total: 105,
    invoice: {
      food: 40,
      daily: 20,
      transport: 0,
      shopping: 0,
      home: 40,
      leisure: 0,
      other: 5,
    },
    account: {
      food: 0,
      daily: 0,
      transport: 0,
      shopping: 0,
      home: 0,
      leisure: 0,
      other: 0,
    },
  }]);
  assert.equal(
    loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer")
      ?.automaticReason,
    "internal_transfer",
  );
  assert.deepEqual(
    loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer") && {
      time: loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer")?.time,
      note: loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer")?.note,
      destinationBankCode: loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer")
        ?.destinationBankCode,
      destinationAccountNumber: loaded.accountRecords.find((row) => row.statementRowId === "mirrored-transfer")
        ?.destinationAccountNumber,
    },
    {
      time: "17:27:28",
      note: "06600000102281740 7097230279900200",
      destinationBankCode: "066",
      destinationAccountNumber: "00000102281740",
    },
  );
  assert.equal(
    loaded.accountRecords.find((row) => row.statementRowId === "card-payment")
      ?.automaticReason,
    "credit_card_payment",
  );
  assert.equal(loaded.recordsByDate.flatMap((group) => group.records).length, 4);
  assert.equal(Object.hasOwn(confirmedInvoice ?? {}, "rawPayloadJson"), false);

  updateSpendingTransactionOverride({
    statementRowId: "card-payment",
    state: "included",
    category: "home",
    automaticState: "excluded",
    automaticReason: "credit_card_payment",
  }, ledgerDir);
  const overridden = loadSpending(ledgerDir);
  assert.equal(
    overridden.accountRecords.find((row) => row.statementRowId === "card-payment")?.state,
    "included",
  );
  assert.equal(overridden.monthlyRows[0]?.account.home, 300);

  updateSpendingTransactionOverride({ statementRowId: "card-payment", state: null }, ledgerDir);
  assert.equal(
    loadSpending(ledgerDir).accountRecords.find((row) => row.statementRowId === "card-payment")
      ?.state,
    "excluded",
  );
  assert.throws(
    () => updateSpendingTransactionOverride({
      statementRowId: " ",
      state: "included",
      category: "home",
      automaticState: "excluded",
      automaticReason: "credit_card_payment",
    }, ledgerDir),
    /statement row id is required/i,
  );
  assert.throws(
    () => updateSpendingTransactionOverride({
      statementRowId: "card-payment",
      state: "invalid" as never,
      category: "home",
      automaticState: "excluded",
      automaticReason: "credit_card_payment",
    }, ledgerDir),
    /Unknown spending state: invalid/,
  );
  assert.throws(
    () => updateSpendingTransactionOverride({
      statementRowId: "card-payment",
      state: "included",
      category: "invalid" as never,
      automaticState: "excluded",
      automaticReason: "credit_card_payment",
    }, ledgerDir),
    /Unknown spending category: invalid/,
  );
  assert.throws(
    () => updateSpendingTransactionOverride({
      statementRowId: "missing",
      state: "included",
      category: "home",
      automaticState: "excluded",
      automaticReason: "credit_card_payment",
    }, ledgerDir),
    /No account transaction found for statement row id: missing/,
  );

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

  const januaryDb = openLedgerDatabase(ledgerDir);
  insertInvoice(januaryDb, {
    invoiceKey: "january-invoice",
    invoiceId: "IJ12345678",
    status: "confirmed",
    amount: 70,
    issuedAt: Date.UTC(2026, 0, 15, 12) / 1000,
  });
  insertItem(januaryDb, {
    itemKey: "january-item",
    invoiceKey: "january-invoice",
    sequence: 1,
    paidAmount: 70,
    productName: "January meal",
    category: "food",
  });
  insertAccountTransaction(januaryDb, {
    statementRowId: "january-account-spend",
    accountNumber: "111",
    date: "2026-01-15",
    description: "簽帳消費",
    withdrawalAmount: 30,
  });
  januaryDb.close();

  const january = loadSpending(ledgerDir, { selectedMonth: "2026-01" });
  assert.equal(january.selectedMonth, "2026-01");
  assert.deepEqual(january.selectedMonthSummary, {
    total: 100,
    invoiceCount: 1,
    accountCount: 1,
  });
  assert.deepEqual(january.dailyRows.map((row) => [row.date, row.total]), [["2026-01-15", 100]]);
  assert.deepEqual(january.invoices.map((invoice) => invoice.invoiceKey), ["january-invoice"]);
  assert.deepEqual(
    january.recordsByDate.flatMap((group) => group.records).map((record) => record.key).sort(),
    ["account:january-account-spend", "invoice:january-invoice"],
  );
  const januaryFood = loadSpending(ledgerDir, {
    selectedMonth: "2026-01",
    selectedCategory: "food",
  });
  assert.equal(januaryFood.selectedCategory, "food");
  assert.deepEqual(
    januaryFood.recordsByDate.flatMap((group) => group.records).map((record) => record.key),
    ["invoice:january-invoice"],
  );
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
