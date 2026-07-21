import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { sourceVersionKey } from "../../../ledger/source-version.ts";
import { loadAssets } from "../../assets/server/load-assets.ts";
import { loadLiabilities } from "../../liabilities/server/load-liabilities.ts";
import { loadOverview } from "../../overview/server/load-overview.ts";
import { loadSpending } from "../../spending/server/store.ts";

const FIXTURE = {
  bank: "example-bank",
  assetAccount: "asset-0420",
  loanAccount: "loan-1701",
  validStatement: "synthetic-valid",
  validLoanStatement: "synthetic-valid-loan",
  wrongStatement: "synthetic-wrong",
} as const;

assert.deepEqual(
  [FIXTURE.bank, FIXTURE.assetAccount, FIXTURE.loanAccount],
  ["example-bank", "asset-0420", "loan-1701"],
);

const ledgerDir = await mkdtemp(join(tmpdir(), "active-lineage-pages-"));
try {
  const db = openLedgerDatabase(ledgerDir);
  const importedAt = "2026-07-20T00:00:00.000Z";
  const versionA = sourceVersionKey(FIXTURE.bank, "statements", "hash-version-a");
  const versionB = sourceVersionKey(FIXTURE.bank, "statements", "hash-version-b");
  const insertSource = db.prepare(`
    INSERT INTO source_file_imports (
      source_file_id, import_run_id, source_version_key, source_relative_path,
      source_file_hash, source_file_bytes, source_file_modified_at, imported_at,
      bank, product, row_count, status, record_json, first_seen_at, last_seen_at,
      observation_count
    ) VALUES (?, ?, ?, ?, ?, 100, NULL, ?, ?, 'statements', 2, 'imported', '{}', ?, ?, 1)
  `);
  insertSource.run(
    "source-a",
    "run-a",
    versionA,
    "example-bank/version-a.csv",
    "hash-version-a",
    importedAt,
    FIXTURE.bank,
    importedAt,
    importedAt,
  );
  insertSource.run(
    "source-b",
    "run-b",
    versionB,
    "example-bank/version-b.csv",
    "hash-version-b",
    importedAt,
    FIXTURE.bank,
    importedAt,
    importedAt,
  );

  db.prepare(`
    INSERT INTO account_transactions (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product, raw_payload_json,
      imported_at, created_at, account_number, currency, transaction_date,
      description, withdrawal_amount, balance_after
    ) VALUES (?, 'source-a', 'run-a', 'example-bank/version-a.csv', 1,
      'source-valid', 'content-valid', ?, 'statements', '{}', ?, ?, ?, 'TWD',
      '2026-07-20', 'Synthetic purchase', 125, 1250)
  `).run(FIXTURE.validStatement, FIXTURE.bank, importedAt, importedAt, FIXTURE.assetAccount);

  db.prepare(`
    INSERT INTO loan_transactions (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product, raw_payload_json,
      imported_at, created_at, account_number, trade_date, item, amount, balance_after
    ) VALUES (?, 'source-a', 'run-a', 'example-bank/version-a.csv', 2,
      'source-wrong', 'content-wrong', ?, 'statements', '{}', ?, ?, ?,
      '2026-07-20', 'Synthetic principal', 900, 9000)
  `).run(FIXTURE.wrongStatement, FIXTURE.bank, importedAt, importedAt, FIXTURE.loanAccount);

  db.prepare(`
    INSERT INTO loan_transactions (
      statement_row_id, source_file_id, import_run_id, source_relative_path,
      source_row_index, source_hash, content_hash, bank, product, raw_payload_json,
      imported_at, created_at, account_number, trade_date, item, amount, balance_after
    ) VALUES (?, 'source-a', 'run-a', 'example-bank/version-a.csv', 3,
      'source-valid-loan', 'content-valid-loan', ?, 'statements', '{}', ?, ?, ?,
      '2026-07-20', 'Synthetic principal', 600, 6000)
  `).run(FIXTURE.validLoanStatement, FIXTURE.bank, importedAt, importedAt, FIXTURE.loanAccount);

  const insertLineage = db.prepare(`
    INSERT INTO source_row_lineage (
      source_file_id, import_run_id, source_version_key, source_row_index,
      projection_table, statement_row_id, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'inserted', ?)
  `);
  insertLineage.run("source-a", "run-a", versionA, 1, "account_transactions", FIXTURE.validStatement, importedAt);
  insertLineage.run("source-a", "run-a", versionA, 2, "loan_transactions", FIXTURE.wrongStatement, importedAt);
  insertLineage.run("source-b", "run-b", versionB, 1, "account_transactions", FIXTURE.validStatement, importedAt);
  insertLineage.run("source-a", "run-a", versionA, 3, "loan_transactions", FIXTURE.validLoanStatement, importedAt);
  insertLineage.run("source-b", "run-b", versionB, 2, "loan_transactions", FIXTURE.validLoanStatement, importedAt);
  db.prepare(`
    INSERT INTO disabled_import_sources (
      disabled_import_source_id, data_issue_id, source_file_id, import_run_id,
      source_version_key, reason, state, disabled_at, preview_token
    ) VALUES ('disabled-a', 'synthetic-case', 'source-a', 'run-a', ?,
      'Synthetic correction', 'active', ?, 'synthetic-preview')
  `).run(versionA, importedAt);
  db.close();

  const [assets, liabilities, overview] = await Promise.all([
    loadAssets(ledgerDir),
    loadLiabilities(ledgerDir),
    loadOverview(ledgerDir),
  ]);
  const spending = loadSpending(ledgerDir);
  const asset = assets.accounts.find((account) => account.institution === "Example Bank");
  assert.ok(asset);
  assert.equal(asset.amountLines.find((amount) => amount.currency === "TWD")?.value, 1250);
  assert.equal(
    Object.values(assets.transactionsByAccount).flat().some((row) => row.label === "Synthetic purchase"),
    true,
  );
  assert.equal(assets.dailyHistoryByAccount[asset.id]?.at(-1)?.assets[0]?.value, 1250);
  const loan = liabilities.accounts.find((account) => account.institution === "Example Bank");
  assert.ok(loan);
  assert.equal(loan.amountLines[0]?.value, 6000);
  assert.equal(liabilities.dailyHistoryByAccount[loan.id]?.at(-1)?.liabilities[0]?.value, 6000);
  assert.equal(overview.accounts.length, 2);
  assert.equal(overview.accounts[0]?.institution, "Example Bank");
  assert.equal(
    overview.summary.find((metric) => metric.label === "Asset value")
      ?.amounts.find((amount) => amount.currency === "TWD")?.value,
    asset.amountLines.find((amount) => amount.currency === "TWD")?.value,
  );
  assert.equal(
    overview.summary.find((metric) => metric.label === "Liabilities")
      ?.amounts.find((amount) => amount.currency === "TWD")?.value,
    6000,
  );
  assert.equal(overview.dailyHistory.at(-1)?.assets[0]?.value, 1250);
  assert.equal(overview.dailyHistory.at(-1)?.liabilities[0]?.value, 6000);
  assert.equal(
    spending.accountRecords.some((row) => row.statementRowId === FIXTURE.validStatement),
    true,
  );
  assert.equal(
    spending.accountRecords.some((row) => row.statementRowId === FIXTURE.wrongStatement),
    false,
  );
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
