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
const spendingByMonth = spending.months.map((selectedMonth) =>
  loadSpending(ledgerDir, { selectedMonth })
);
const categories = new Set(spendingByMonth.flatMap((month) => month.invoices).flatMap((invoice) =>
  invoice.items.map((item) => item.category)
));

assert.equal(spending.months.length, 4);
assert.deepEqual([...categories].sort(), [...SPENDING_CATEGORY_IDS].sort());
assert.ok(spending.invoices.some((invoice) => invoice.items.length > 1));
assert.ok(new Set(
  spending.invoices
    .filter((invoice) => new Date(invoice.issuedAt * 1000).toISOString().startsWith("2026-07"))
    .map((invoice) => new Date(invoice.issuedAt * 1000).toISOString().slice(0, 10)),
).size >= 3);

assert.equal(spending.selectedMonth, "2026-07");
assert.ok(spending.recordsByDate.every((group) =>
  group.date.startsWith(spending.selectedMonth!) &&
  group.records.every((record) => record.date === group.date)
));
assert.ok(spending.recordsByDate.flatMap((group) => group.records).some((record) =>
  record.source === "account" &&
  record.statementRowId === "mock-account.2026-06-27.6" &&
  record.label === "金融卡消費 咖啡店" &&
  record.state === "included" &&
  record.automaticReason === "direct_purchase"
));
assert.ok(spending.excludedAccountRecords.some((record) =>
  record.statementRowId === "mock-account.2026-06-27.7" &&
  record.label === "繳信用卡" &&
  record.automaticReason === "credit_card_payment"
));
assert.ok(spending.excludedAccountRecords.some((record) =>
  record.statementRowId === "mock-account.2026-06-27.2" &&
  record.label === "房租轉帳" &&
  record.automaticReason === "internal_transfer"
));
assert.ok(spending.pendingAccountRecords.some((record) =>
  record.statementRowId === "mock-account.2026-06-27.5" &&
  record.label === "ATM 提款" &&
  record.automaticReason === "cash_withdrawal"
));

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
const csvProjections = [
  "account_transactions",
  "foreign_currency_transactions",
  "credit_card_statement_lines",
  "loan_transactions",
  "fund_holdings",
  "fund_buy_transactions",
  "fund_redemption_transactions",
  "fund_cash_dividends",
  "fund_conversion_transactions",
  "brokerage_holdings",
  "brokerage_asset_summaries",
  "brokerage_trade_transactions",
  "unsupported_statement_rows",
  "personal_invoices",
  "personal_invoice_items",
] as const;
for (const projection of csvProjections) {
  const typed = db.prepare(`SELECT COUNT(*) AS count FROM ${projection}`).get() as { count: number };
  const supported = db.prepare(`
    SELECT COUNT(DISTINCT lineage.statement_row_id) AS count
    FROM source_row_lineage AS lineage
    JOIN source_file_imports AS source USING (source_version_key)
    WHERE lineage.projection_table = ?
  `).get(projection) as { count: number };
  assert.ok(typed.count > 0, `${projection} fixture is empty`);
  assert.equal(supported.count, typed.count, `${projection} lacks canonical lineage`);
}
const accountSource = db.prepare(`
  SELECT row_count FROM source_files WHERE source_file_id = ?
`).get("account.2026-06-27") as { row_count: number };
db.close();

assert.equal(invoiceCounts.voided, 1);
assert.equal(invoiceCounts.total, spendingByMonth.flatMap((month) => month.invoices).length + 1);
assert.deepEqual(automationStatuses.map((row) => row.status), ["completed", "failed"]);
assert.ok(typedCounts.accounts > 0);
assert.ok(typedCounts.brokerage > 0);
assert.ok(typedCounts.invoice_items > 0);
assert.equal(accountSource.row_count, 8);

const editableItem = spending.invoices[0]?.items[0];
assert.ok(editableItem);
updateSpendingItemCategory({ itemKey: editableItem.itemKey, category: "home" }, ledgerDir);
assert.equal(
  loadSpending(ledgerDir).invoices
    .flatMap((invoice) => invoice.items)
    .find((item) => item.itemKey === editableItem.itemKey)?.category,
  "home",
);
