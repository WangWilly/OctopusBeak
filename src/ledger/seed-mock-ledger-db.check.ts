import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpending, updateSpendingItemCategory } from "../lib/spending/server/store.ts";
import { openLedgerDatabase } from "./db/client.ts";
import { seedMockLedger } from "./seed-mock-ledger-db.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "octopusbeak-mock-ledger-"));
seedMockLedger(ledgerDir, new Date("2026-07-11T04:00:00.000Z"));

const spending = loadSpending(ledgerDir);
assert.equal(spending.canonical?.availability, "empty");
assert.deepEqual(spending.canonical?.transactions, []);
assert.deepEqual(spending.invoices, []);
assert.deepEqual(spending.accountRecords, []);

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
assert.ok(invoiceCounts.total > 0);
assert.deepEqual(automationStatuses.map((row) => row.status), ["completed", "failed"]);
assert.ok(typedCounts.accounts > 0);
assert.ok(typedCounts.brokerage > 0);
assert.ok(typedCounts.invoice_items > 0);
assert.equal(accountSource.row_count, 8);

assert.throws(
  () => updateSpendingItemCategory({ itemKey: "legacy-item", category: "home" }, ledgerDir),
  /legacy invoice categorization/,
);
