import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpending, updateSpendingItemCategory } from "../lib/spending/server/store.ts";
import { SPENDING_CATEGORY_IDS } from "../lib/spending/categories.ts";
import { openLedgerDatabase } from "./db/client.ts";
import { seedMockLedger } from "./seed-mock-ledger-db.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "octopusbeak-mock-ledger-"));
seedMockLedger(ledgerDir, new Date("2026-07-11T04:00:00.000Z"));

const spending = loadSpending(ledgerDir);
const months = new Set(spending.invoices.map((invoice) =>
  new Date(invoice.issuedAt * 1000).toISOString().slice(0, 7)
));
const categories = new Set(spending.invoices.flatMap((invoice) =>
  invoice.items.map((item) => item.category)
));

assert.equal(months.size, 4);
assert.deepEqual([...categories].sort(), [...SPENDING_CATEGORY_IDS].sort());
assert.ok(spending.invoices.some((invoice) => invoice.items.length > 1));

const db = openLedgerDatabase(ledgerDir, { readOnly: true });
const invoiceCounts = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'voided' THEN 1 ELSE 0 END) AS voided
  FROM personal_invoices
`).get() as { total: number; voided: number };
const automationStatuses = db.prepare(`
  SELECT DISTINCT status FROM automation_task_runs ORDER BY status
`).all() as Array<{ status: string }>;
const typedCounts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM account_transactions) AS accounts,
    (SELECT COUNT(*) FROM brokerage_holdings) AS brokerage,
    (SELECT COUNT(*) FROM personal_invoice_items) AS invoice_items
`).get() as { accounts: number; brokerage: number; invoice_items: number };
db.close();

assert.equal(invoiceCounts.voided, 1);
assert.equal(invoiceCounts.total, spending.invoices.length + 1);
assert.deepEqual(automationStatuses.map((row) => row.status), ["completed", "failed"]);
assert.ok(typedCounts.accounts > 0);
assert.ok(typedCounts.brokerage > 0);
assert.ok(typedCounts.invoice_items > 0);

const editableItem = spending.invoices[0]?.items[0];
assert.ok(editableItem);
updateSpendingItemCategory({ itemKey: editableItem.itemKey, category: "home" }, ledgerDir);
assert.equal(
  loadSpending(ledgerDir).invoices
    .flatMap((invoice) => invoice.items)
    .find((item) => item.itemKey === editableItem.itemKey)?.category,
  "home",
);
