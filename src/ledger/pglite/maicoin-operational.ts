import { createHash } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/** MAX sync diagnostics and source snapshots are operational records. */
export type PGliteMaicoinRunStart = Readonly<{
  syncRunId: string;
  startedAt: string;
  subAccount: string;
  walletTypes: readonly string[];
  statementLimit: number;
  record: Readonly<Record<string, unknown>>;
}>;

export type PGliteMaicoinSnapshot = Readonly<{
  snapshotId: string; syncRunId: string; capturedAt: string; subAccount: string;
  walletType: string; currency: string; balance: number; locked: number;
  staked: number | null; principal: number | null; interest: number | null;
  totalQuantity: number; priceMarket: string | null; priceCurrency: string | null;
  price: number | null; valueTwd: number | null; priceAt: string | null;
  rawAccountJson: string; rawPriceJson: string | null;
}>;

export type PGliteMaicoinStatementRow = Readonly<{
  statementId: string; syncRunId: string; capturedAt: string;
  endpoint: string; walletType: string | null; rowType: string; externalId: string;
  occurredAt: string | null; currency: string | null; amount: number | null;
  fee: number | null; feeCurrency: string | null; market: string | null;
  side: string | null; price: number | null; valueTwd: number | null;
  rawPayloadJson: string;
}>;

export type PGliteMaicoinRunFinish = Readonly<{
  syncRunId: string;
  finishedAt: string;
  record: Readonly<Record<string, unknown>>;
}>;

export type PGliteMaicoinPersistencePort = Readonly<{
  startRun(input: PGliteMaicoinRunStart): Promise<void>;
  appendSnapshots(rows: readonly PGliteMaicoinSnapshot[]): Promise<void>;
  appendStatementRows(rows: readonly PGliteMaicoinStatementRow[]): Promise<void>;
  finishRun(input: PGliteMaicoinRunFinish): Promise<void>;
}>;

export const PGLITE_MAICOIN_OPERATIONAL_SQL = String.raw`
CREATE TABLE maicoin_sync_runs (
  sync_run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  sub_account TEXT NOT NULL,
  wallet_types_json TEXT NOT NULL,
  statement_enabled INTEGER NOT NULL,
  statement_limit INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE TABLE maicoin_account_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES maicoin_sync_runs(sync_run_id),
  captured_at TEXT NOT NULL,
  sub_account TEXT NOT NULL,
  wallet_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance DOUBLE PRECISION NOT NULL,
  locked DOUBLE PRECISION NOT NULL,
  staked DOUBLE PRECISION,
  principal DOUBLE PRECISION,
  interest DOUBLE PRECISION,
  total_quantity DOUBLE PRECISION NOT NULL,
  price_market TEXT,
  price_currency TEXT,
  price DOUBLE PRECISION,
  value_twd DOUBLE PRECISION,
  price_at TEXT,
  raw_account_json TEXT NOT NULL,
  raw_price_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_maicoin_account_snapshots_run
  ON maicoin_account_snapshots(sync_run_id);
CREATE INDEX idx_maicoin_account_snapshots_latest
  ON maicoin_account_snapshots(sub_account, wallet_type, currency, captured_at);
CREATE TABLE maicoin_statement_rows (
  statement_id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES maicoin_sync_runs(sync_run_id),
  captured_at TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  wallet_type TEXT,
  row_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  occurred_at TEXT,
  currency TEXT,
  amount DOUBLE PRECISION,
  fee DOUBLE PRECISION,
  fee_currency TEXT,
  market TEXT,
  side TEXT,
  price DOUBLE PRECISION,
  value_twd DOUBLE PRECISION,
  raw_payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_maicoin_statement_rows_run
  ON maicoin_statement_rows(sync_run_id);
CREATE INDEX idx_maicoin_statement_rows_time
  ON maicoin_statement_rows(row_type, occurred_at);
`;

const MAICOIN_MIGRATION_ID = "maicoin-operational-v1";
const MAICOIN_MIGRATION_SIGNATURE = createHash("sha256")
  .update(PGLITE_MAICOIN_OPERATIONAL_SQL)
  .digest("hex");
// Catalog signature from a clean application of the reviewed v1 migration.
const MAICOIN_CATALOG_SIGNATURE = [
  "09467d1324338a5aff29b279a4351f3e",
  "3a5a5247a3b3df4ed19a9e333c16d09a",
].join("");
const MAICOIN_RECORDED_SIGNATURE = `${MAICOIN_MIGRATION_SIGNATURE}:${MAICOIN_CATALOG_SIGNATURE}`;
const MAICOIN_TABLES = ["maicoin_sync_runs", "maicoin_account_snapshots", "maicoin_statement_rows"];
const MAICOIN_INDEXES = [
  "idx_maicoin_account_snapshots_run",
  "idx_maicoin_account_snapshots_latest",
  "idx_maicoin_statement_rows_run",
  "idx_maicoin_statement_rows_time",
];

async function maicoinCatalogSignature(transaction: PGliteTransaction): Promise<string> {
  const [tables, columns, indexes, constraints] = await Promise.all([
    transaction.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [MAICOIN_TABLES],
    ),
    transaction.query<{
      table_name: string; ordinal_position: number; column_name: string;
      data_type: string; is_nullable: string; column_default: string | null;
    }>(
      `SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [MAICOIN_TABLES],
    ),
    transaction.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ANY($1::text[])
        ORDER BY tablename, indexname`,
      [MAICOIN_TABLES],
    ),
    transaction.query<{ table_name: string; constraint_name: string; definition: string }>(
      `SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name,
              pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid = constraint_row.conrelid
        WHERE relation.relnamespace = current_schema()::regnamespace
          AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname, constraint_row.conname`,
      [MAICOIN_TABLES],
    ),
  ]);
  if (tables.rows.length !== MAICOIN_TABLES.length
    || MAICOIN_INDEXES.some((name) => !indexes.rows.some((row) => row.indexname === name)))
    throw new Error("MaiCoin operational migration object inventory is incomplete.");
  return createHash("sha256")
    .update(JSON.stringify({ columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows }))
    .digest("hex");
}

/** A reviewed one-time migration, applied atomically after the operational baseline. */
export async function applyPgliteMaicoinOperationalSchema(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pglite_operational_migrations (
      migration_key TEXT PRIMARY KEY,
      schema_signature TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const installed = await transaction.query<{ schema_signature: string }>(
      "SELECT schema_signature FROM pglite_operational_migrations WHERE migration_key=$1",
      [MAICOIN_MIGRATION_ID],
    );
    if (installed.rows[0]) {
      if (installed.rows[0].schema_signature !== MAICOIN_RECORDED_SIGNATURE
        && installed.rows[0].schema_signature !== MAICOIN_MIGRATION_SIGNATURE)
        throw new Error("MaiCoin operational migration signature has changed.");
      if (await maicoinCatalogSignature(transaction) !== MAICOIN_CATALOG_SIGNATURE)
        throw new Error("MaiCoin operational migration catalog has changed.");
      if (installed.rows[0].schema_signature === MAICOIN_MIGRATION_SIGNATURE)
        await transaction.query(
          "UPDATE pglite_operational_migrations SET schema_signature=$2 WHERE migration_key=$1",
          [MAICOIN_MIGRATION_ID, MAICOIN_RECORDED_SIGNATURE],
        );
      return;
    }
    const prior = await transaction.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [MAICOIN_TABLES],
    );
    if (prior.rows.length > 0)
      throw new Error("MaiCoin operational tables exist without a migration record.");
    await transaction.exec(PGLITE_MAICOIN_OPERATIONAL_SQL);
    const catalogSignature = await maicoinCatalogSignature(transaction);
    if (catalogSignature !== MAICOIN_CATALOG_SIGNATURE)
      throw new Error("MaiCoin operational migration catalog does not match its reviewed schema.");
    await transaction.query(
      "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
      [MAICOIN_MIGRATION_ID, MAICOIN_RECORDED_SIGNATURE],
    );
  });
}

export function createPGliteMaicoinPersistence(store: PGliteStore): PGliteMaicoinPersistencePort {
  return Object.freeze({
    async startRun(input) {
      await store.query(
        `INSERT INTO maicoin_sync_runs(sync_run_id, started_at, sub_account, wallet_types_json,
          statement_enabled, statement_limit, record_json)
         VALUES ($1, $2, $3, $4, 1, $5, $6)`,
        [input.syncRunId, input.startedAt, input.subAccount,
          JSON.stringify(input.walletTypes), input.statementLimit, JSON.stringify(input.record)],
      );
    },
    async appendSnapshots(rows) {
      await store.transaction(async (transaction) => {
        for (const row of rows) await transaction.query(
          `INSERT INTO maicoin_account_snapshots(snapshot_id, sync_run_id, captured_at,
            sub_account, wallet_type, currency, balance, locked, staked, principal,
            interest, total_quantity, price_market, price_currency, price, value_twd,
            price_at, raw_account_json, raw_price_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [row.snapshotId, row.syncRunId, row.capturedAt, row.subAccount,
            row.walletType, row.currency, row.balance, row.locked, row.staked,
            row.principal, row.interest, row.totalQuantity, row.priceMarket,
            row.priceCurrency, row.price, row.valueTwd, row.priceAt,
            row.rawAccountJson, row.rawPriceJson],
        );
      });
    },
    async appendStatementRows(rows) {
      await store.transaction(async (transaction) => {
        for (const row of rows) await transaction.query(
          `INSERT INTO maicoin_statement_rows(statement_id, sync_run_id, captured_at,
            endpoint, wallet_type, row_type, external_id, occurred_at, currency,
            amount, fee, fee_currency, market, side, price, value_twd, raw_payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT(statement_id) DO UPDATE SET
             sync_run_id=EXCLUDED.sync_run_id, captured_at=EXCLUDED.captured_at,
             occurred_at=EXCLUDED.occurred_at, currency=EXCLUDED.currency,
             amount=EXCLUDED.amount, fee=EXCLUDED.fee,
             fee_currency=EXCLUDED.fee_currency, market=EXCLUDED.market,
             side=EXCLUDED.side, price=EXCLUDED.price,
             value_twd=EXCLUDED.value_twd, raw_payload_json=EXCLUDED.raw_payload_json,
             updated_at=CURRENT_TIMESTAMP`,
          [row.statementId, row.syncRunId, row.capturedAt, row.endpoint,
            row.walletType, row.rowType, row.externalId, row.occurredAt,
            row.currency, row.amount, row.fee, row.feeCurrency, row.market,
            row.side, row.price, row.valueTwd, row.rawPayloadJson],
        );
      });
    },
    async finishRun(input) {
      const updated = await store.query<{ sync_run_id: string }>(
        `UPDATE maicoin_sync_runs SET finished_at=$2, record_json=$3
          WHERE sync_run_id=$1 RETURNING sync_run_id`,
        [input.syncRunId, input.finishedAt, JSON.stringify(input.record)],
      );
      if (updated.rows.length !== 1) throw new Error("MaiCoin PGlite sync run is missing.");
    },
  });
}
