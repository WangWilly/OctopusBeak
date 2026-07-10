import { DEFAULT_LEDGER_DIR, openLedgerDatabase } from "../../../ledger/db/client.ts";
import { isSpendingCategory, type SpendingCategory } from "../categories.ts";
import type {
  SpendingInvoiceDto,
  SpendingPageDto,
} from "../model.ts";

type SpendingRow = {
  invoice_key: string;
  invoice_id: string;
  issued_at: unknown;
  invoice_amount: number | null;
  seller_business_account_number: string | null;
  seller_name: string | null;
  seller_addr: string | null;
  item_key: string | null;
  item_sequence_number: number | null;
  item_quantity: number | null;
  item_unit_price: number | null;
  item_paid_amount: number | null;
  item_product_name: string | null;
  category: SpendingCategory | null;
};

export function loadSpending(ledgerDir = DEFAULT_LEDGER_DIR): SpendingPageDto {
  const db = openLedgerDatabase(ledgerDir);
  try {
    const rows = db.prepare(`
      SELECT
        invoices.invoice_key,
        invoices.invoice_id,
        invoices.issued_at,
        invoices.amount AS invoice_amount,
        invoices.seller_business_account_number,
        invoices.seller_name,
        invoices.seller_addr,
        items.item_key,
        items.item_sequence_number,
        items.item_quantity,
        items.item_unit_price,
        items.item_paid_amount,
        items.item_product_name,
        items.category
      FROM personal_invoices AS invoices
      LEFT JOIN personal_invoice_items AS items USING (invoice_key)
      WHERE invoices.status = ?
      ORDER BY invoices.issued_at, invoices.invoice_key, items.item_sequence_number
    `).all("confirmed") as SpendingRow[];

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
    return { invoices };
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
