import { DEFAULT_LEDGER_DIR, openLedgerDatabase } from "../../../ledger/db/client.ts";
import { isSpendingCategory, type SpendingCategory } from "../categories.ts";
import type {
  SpendingAccountTransactionInput,
  SpendingCardPaymentInput,
  SpendingInvoiceDto,
  SpendingModel,
  SpendingOverrideDto,
  SpendingReason,
  SpendingState,
} from "../model.ts";
import { buildSpendingModel, SPENDING_REASONS } from "../model.ts";
import { activeImportSql } from "../../data-issues/server/ledger-visibility.ts";
import {
  createFinancialQuery,
  type LegacySpendingAccountRow,
  type LegacySpendingCardPaymentRow,
  type LegacySpendingOverrideRow,
} from "../../shared-ledger/server/financial-query.ts";

export { activeImportSql };

const SPENDING_STATES = new Set<SpendingState>(["included", "excluded", "pending"]);
const SPENDING_REASON_SET = new Set<SpendingReason>(SPENDING_REASONS);

export type SpendingOverrideUpdate =
  | { statementRowId: string; state: null }
  | {
    statementRowId: string;
    state: SpendingState;
    category: SpendingCategory | null;
    automaticState: SpendingState;
    automaticReason: SpendingReason | null;
  };

export type SpendingLoadInput = {
  selectedMonth?: string;
  selectedCategory?: SpendingCategory;
};

export function loadSpending(
  ledgerDir = DEFAULT_LEDGER_DIR,
  { selectedMonth, selectedCategory }: SpendingLoadInput = {},
): SpendingModel {
  const { spending } = createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "spending",
  });
  {
    const rows = spending.invoices;
    const accountRows = spending.accountTransactions;
    const cardPaymentRows = spending.cardPayments;
    const overrideRows = spending.overrides;
    const invoices: SpendingInvoiceDto[] = [];
    const invoicesByKey = new Map<string, SpendingInvoiceDto>();
    for (const row of rows) {
      const issuedAt = row.issued_at;
      if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || issuedAt <= 0) {
        continue;
      }
      let invoice = invoicesByKey.get(row.invoice_key);
      if (!invoice) {
        invoice = {
          invoiceKey: row.invoice_key,
          invoiceId: row.invoice_id,
          issuedAt,
          amount: Number(row.invoice_amount ?? 0),
          sellerBusinessAccountNumber: row.seller_business_account_number,
          sellerName: row.seller_name,
          sellerAddr: row.seller_addr,
          items: [],
        };
        invoicesByKey.set(row.invoice_key, invoice);
        invoices.push(invoice);
      }
      if (row.item_key && row.category) {
        invoice.items.push({
          itemKey: row.item_key,
          sequence: row.item_sequence_number === null
            ? null
            : Number(row.item_sequence_number),
          quantity: row.item_quantity === null ? null : Number(row.item_quantity),
          unitPrice: row.item_unit_price === null ? null : Number(row.item_unit_price),
          paidAmount: Number(row.item_paid_amount ?? 0),
          productName: row.item_product_name,
          category: row.category,
        });
      }
    }
    const accountTransaction = (row: LegacySpendingAccountRow, amount: number): SpendingAccountTransactionInput => ({
      statementRowId: row.statement_row_id,
      bank: row.bank,
      accountNumber: row.account_number,
      currency: row.currency,
      date: row.date,
      time: row.transaction_time,
      description: row.description,
      note: row.note,
      amount,
    });
    const accountTransactions = accountRows
      .filter((row) => Number(row.withdrawal_amount) > 0)
      .map((row) => accountTransaction(row, Number(row.withdrawal_amount)));
    const counterpartDeposits = accountRows
      .filter((row) => Number(row.deposit_amount) > 0)
      .map((row) => accountTransaction(row, Number(row.deposit_amount)));
    const cardPayments: SpendingCardPaymentInput[] = cardPaymentRows.map((row: LegacySpendingCardPaymentRow) => ({
      date: row.date,
      amount: Math.abs(Number(row.twd_amount)),
    }));
    const overrides: SpendingOverrideDto[] = overrideRows.map((row: LegacySpendingOverrideRow) => ({
      statementRowId: row.statement_row_id,
      state: row.state,
      category: row.category,
      automaticState: row.automatic_state,
      automaticReason: row.automatic_reason,
      updatedAt: row.updated_at,
    }));
    return buildSpendingModel({
      invoices,
      accountTransactions,
      counterpartDeposits,
      cardPayments,
      overrides,
      selectedMonth,
      selectedCategory,
    });
  }
}

export function updateSpendingTransactionOverride(
  input: SpendingOverrideUpdate,
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  if (typeof input.statementRowId !== "string" || input.statementRowId.trim() === "") {
    throw new Error("Spending statement row id is required");
  }
  if (input.state !== null && !SPENDING_STATES.has(input.state)) {
    throw new Error(`Unknown spending state: ${String(input.state)}`);
  }
  if (input.state !== null && input.category !== null && !isSpendingCategory(input.category)) {
    throw new Error(`Unknown spending category: ${String(input.category)}`);
  }
  if (input.state !== null && !SPENDING_STATES.has(input.automaticState)) {
    throw new Error(`Unknown automatic spending state: ${String(input.automaticState)}`);
  }
  if (input.state !== null && input.automaticReason !== null &&
    !SPENDING_REASON_SET.has(input.automaticReason)) {
    throw new Error(`Unknown automatic spending reason: ${String(input.automaticReason)}`);
  }

  const db = openLedgerDatabase(ledgerDir);
  try {
    if (input.state === null) {
      db.prepare(`
        DELETE FROM spending_transaction_overrides WHERE statement_row_id = ?
      `).run(input.statementRowId);
      return;
    }
    if (!db.prepare(`
      SELECT 1 FROM account_transactions WHERE statement_row_id = ?
    `).get(input.statementRowId)) {
      throw new Error(`No account transaction found for statement row id: ${input.statementRowId}`);
    }
    db.prepare(`
      INSERT INTO spending_transaction_overrides (
        statement_row_id, state, category, automatic_state,
        automatic_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(statement_row_id) DO UPDATE SET
        state = excluded.state,
        category = excluded.category,
        automatic_state = excluded.automatic_state,
        automatic_reason = excluded.automatic_reason,
        updated_at = excluded.updated_at
    `).run(
      input.statementRowId,
      input.state,
      input.category,
      input.automaticState,
      input.automaticReason,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

export function updateSpendingItemCategory(
  input: { itemKey: string; category: SpendingCategory },
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  if (typeof input.itemKey !== "string" || input.itemKey.trim() === "") {
    throw new Error("Spending item key is required");
  }
  if (!isSpendingCategory(input.category)) {
    throw new Error(`Unknown spending category: ${String(input.category)}`);
  }

  const db = openLedgerDatabase(ledgerDir);
  try {
    const result = db.prepare(`
      UPDATE personal_invoice_items
      SET category = ?
      WHERE item_key = ?
    `).run(input.category, input.itemKey);
    if (result.changes !== 1) {
      throw new Error(`No spending item found for key: ${input.itemKey}`);
    }
  } finally {
    db.close();
  }
}
