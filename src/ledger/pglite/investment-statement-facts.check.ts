import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildMaicoinInvestmentCapture,
  parseMaicoinProviderDate,
  type MaicoinStatementBatch,
} from "../canonical/maicoin-crypto-adapters.ts";
import type { InvestmentCaptureInput } from "../canonical/investment-financial.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
import { applyPgliteInvestmentStatementFactsSchema } from "./investment-statement-facts.ts";
import { installFinancialStore } from "./store-layout.ts";
import { PGliteStore } from "./transaction.ts";

const providerDate = parseMaicoinProviderDate("Fri, 25 Sep 2026 10:00:00 GMT");
const history = { startDate: "2017-12-11", endDate: "2026-09-25", complete: true as const };
const at = (iso: string) => Date.parse(iso);
const ROWS: Readonly<Partial<Record<MaicoinStatementBatch["rowType"], readonly Record<string, unknown>[]>>> = {
  deposit: [
    { sn: "d-btc", currency: "btc", amount: "0.5", state: "done", created_at: at("2026-09-20T03:00:00Z") },
    { sn: "d-twd", currency: "twd", amount: "3000", state: "done", created_at: at("2026-09-20T04:00:00Z") },
    { sn: "d-wait", currency: "btc", amount: "0.1", state: "processing", created_at: at("2026-09-20T05:00:00Z") },
  ],
  reward: [{ uuid: "r-eth", currency: "eth", amount: "2", type: "airdrop", note: "x", created_at: at("2026-09-21T23:30:00Z") }],
  convert: [{ sn: "c-1", from_currency: "twd", to_currency: "btc", from_amount: "100", to_amount: "0.00003", created_at: at("2026-09-22T01:00:00Z") }],
};
const ENDPOINTS = [
  ["/api/v3/fund_transactions/deposits", "deposit"],
  ["/api/v3/fund_transactions/withdrawals", "withdrawal"],
  ["/api/v3/fund_transactions/transfers", "transfer"],
  ["/api/v3/rewards", "reward"],
  ["/api/v3/converts", "convert"],
] as const;

/** A capture as a sync before ADR 0158 admitted it: no row type, state or valuation. */
function preUpgradeCapture(): InvestmentCaptureInput {
  const built = buildMaicoinInvestmentCapture({
    captureId: "pre-upgrade",
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [{ walletType: "spot", providerDate, accounts: [{ currency: "BTC", balance: "1", locked: "0" }] }],
    statementBatches: [
      { endpoint: "/api/v3/wallet/spot/trades", walletType: "spot", rowType: "trade", rows: [], history },
      ...ENDPOINTS.map(([endpoint, rowType]) => ({ endpoint, walletType: null, rowType, rows: ROWS[rowType] ?? [], history })),
    ],
  });
  return {
    ...built,
    transactions: built.transactions.map(({ rowType: _rowType, state: _state, posting: _posting, twdValuation: _valuation, ...row }) => row),
  };
}

/** The retired statement log as the last MAX sync before ADR 0158 left it, with the rows it logged. */
async function seedStatementLog(store: PGliteStore, rows: readonly (readonly [string, string, string, number | null, string])[]) {
  await store.exec(`
    CREATE TABLE maicoin_sync_runs (sync_run_id TEXT PRIMARY KEY);
    CREATE TABLE maicoin_account_snapshots (snapshot_id TEXT PRIMARY KEY, sync_run_id TEXT NOT NULL REFERENCES maicoin_sync_runs(sync_run_id));
    CREATE TABLE maicoin_statement_rows (
      statement_id TEXT PRIMARY KEY, sync_run_id TEXT NOT NULL REFERENCES maicoin_sync_runs(sync_run_id),
      captured_at TEXT NOT NULL, endpoint TEXT NOT NULL, wallet_type TEXT, row_type TEXT NOT NULL,
      external_id TEXT NOT NULL, value_twd DOUBLE PRECISION, raw_payload_json TEXT NOT NULL);
    CREATE INDEX idx_maicoin_statement_rows_run ON maicoin_statement_rows(sync_run_id);
    INSERT INTO maicoin_sync_runs VALUES ('run');
    INSERT INTO maicoin_account_snapshots VALUES ('snapshot', 'run');
    INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ('maicoin-operational-v1', 'reviewed');
    DELETE FROM pglite_operational_migrations WHERE migration_key = 'maicoin-statement-log-retirement-v1';
  `);
  for (const [endpoint, rowType, externalId, valueTwd, payload] of rows)
    await store.query(
      `INSERT INTO maicoin_statement_rows(statement_id, sync_run_id, captured_at, endpoint, wallet_type, row_type, external_id, value_twd, raw_payload_json)
       VALUES ($1, 'run', '2026-09-25T10:00:00.000Z', $2, NULL, $3, $4, $5, $6)`,
      [`${rowType}:${externalId}`, endpoint, rowType, externalId, valueTwd, payload],
    );
}

const LOGGED = [
  ["/api/v3/fund_transactions/deposits", "deposit", "sn:d-btc", 1500000.25, '{"state":"done"}'],
  ["/api/v3/fund_transactions/deposits", "deposit", "sn:d-twd", 3000, '{"state":"done"}'],
  ["/api/v3/fund_transactions/deposits", "deposit", "sn:d-wait", 300000, '{"state":"processing"}'],
  ["/api/v3/rewards", "reward", "uuid:r-eth", 160516.05, "{}"],
  ["/api/v3/converts", "convert", "sn:c-1", 100, "{}"],
] as const;

async function factsByCoin(store: PGliteStore) {
  return (await store.query<{ coin: string; quantity: string; row_type: string | null; price_route: string | null; value: string | null }>(
    `SELECT security.producer_security_id AS coin, investment.quantity_coefficient AS quantity, investment.row_type,
            valuation.price_route, valuation.value_coefficient || '/' || valuation.value_scale AS value
       FROM investment_transactions investment
       JOIN investment_securities security ON security.security_id = investment.security_id
       LEFT JOIN investment_transaction_twd_valuations valuation ON valuation.transaction_id = investment.transaction_id
      ORDER BY coin, quantity`,
  )).rows.map((row) => [row.coin, row.quantity, row.row_type, row.price_route, row.value]);
}

async function logTables(store: PGliteStore) {
  return (await store.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'maicoin\\_%' ORDER BY 1",
  )).rows.map((row) => row.name);
}

async function migrationKeys(store: PGliteStore) {
  return (await store.query<{ key: string }>(
    "SELECT migration_key AS key FROM pglite_operational_migrations WHERE migration_key IN ('maicoin-operational-v1', 'maicoin-statement-log-retirement-v1') ORDER BY 1",
  )).rows.map((row) => row.key);
}

test("retiring the MAX statement log backfills row types and done values, then drops the log, and reruns as a no-op", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await commitPGliteCanonicalInvestmentCapture(store, { capture: preUpgradeCapture() });
    await seedStatementLog(store, LOGGED);
    await applyPgliteInvestmentStatementFactsSchema(store);
    const expected = [
      ["BTC", "1", "deposit", null, null],
      ["BTC", "3", "convert", null, null],
      ["BTC", "5", "deposit", "legacy-log", "150000025/2"],
      ["ETH", "2", "reward", "legacy-log", "16051605/2"],
      ["TWD", "100", "convert", null, null],
      ["TWD", "3000", "deposit", null, null],
    ];
    assert.deepEqual(await factsByCoin(store), expected, "a processing deposit and a TWD deposit get a row type and no value");
    assert.deepEqual(await logTables(store), []);
    assert.deepEqual(await migrationKeys(store), ["maicoin-statement-log-retirement-v1"]);
    await applyPgliteInvestmentStatementFactsSchema(store);
    assert.deepEqual(await factsByCoin(store), expected);
  } finally {
    await store.close();
  }
});

test("a retirement that fails part way leaves the log and the rows untouched, and the next open finishes it", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await commitPGliteCanonicalInvestmentCapture(store, { capture: preUpgradeCapture() });
    await seedStatementLog(store, [...LOGGED, ["/api/v3/rewards", "reward", "uuid:broken", 1, "{not json"]]);
    await assert.rejects(applyPgliteInvestmentStatementFactsSchema(store));
    assert.deepEqual((await factsByCoin(store)).map((row) => row[2]), [null, null, null, null, null, null]);
    assert.deepEqual(await logTables(store), ["maicoin_account_snapshots", "maicoin_statement_rows", "maicoin_sync_runs"]);
    assert.deepEqual(await migrationKeys(store), ["maicoin-operational-v1"]);
    await store.query("DELETE FROM maicoin_statement_rows WHERE external_id = 'uuid:broken'");
    await applyPgliteInvestmentStatementFactsSchema(store);
    assert.deepEqual((await factsByCoin(store)).map((row) => row[2]), ["deposit", "convert", "deposit", "reward", "convert", "deposit"]);
    assert.deepEqual(await logTables(store), []);
  } finally {
    await store.close();
  }
});

test("a store that never synced MAX installs the statement facts with no log to retire", async () => {
  const database = await PGlite.create();
  const store = await installFinancialStore(database);
  try {
    assert.deepEqual(await logTables(store), []);
    assert.deepEqual(await migrationKeys(store), ["maicoin-statement-log-retirement-v1"]);
  } finally {
    await store.close();
  }
});
