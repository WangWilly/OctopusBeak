import { randomUUID } from "node:crypto";
import type { PersonalCategoryCode } from "../canonical/personal-category-codes.ts";
import {
  assertSourceAllowed,
  MANUAL_ASSET_CATEGORIES,
  assertNotFuture,
  ManualAssetRejected,
  parseManualAssetCommand,
  rejectManual as reject,
  type ManualAsset,
  type ManualAssetCategory,
  type ManualAssetCommand,
  type ManualAssetCommandResult,
  type ManualTransaction,
  type ManualTransactionInput,
  type ManualValuation,
  type ManualValuationSource,
} from "../../lib/manual-assets/manual-assets.ts";
import type { ManualSpendingPurchase } from "../../lib/spending/manual-spending.ts";
import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

const DECIMAL = "'^[0-9]+([.][0-9]+)?$'";
const DATE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";

export const PGLITE_MANUAL_ASSETS_SQL = String.raw`
CREATE TABLE manual_assets (
  asset_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('cash', 'house', 'insurance', 'vehicle', 'labor_pension', 'other')),
  name TEXT NOT NULL CHECK (name <> ''),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ended_on TEXT CHECK (ended_on IS NULL OR ended_on ~ ${DATE}),
  created_at TEXT NOT NULL
);
CREATE TABLE manual_valuations (
  asset_id TEXT NOT NULL REFERENCES manual_assets(asset_id) ON DELETE CASCADE,
  valued_on TEXT NOT NULL CHECK (valued_on ~ ${DATE}),
  amount TEXT NOT NULL CHECK (amount ~ ${DECIMAL}),
  source TEXT NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, valued_on)
);
CREATE TABLE manual_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES manual_assets(asset_id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL CHECK (occurred_on ~ ${DATE}),
  amount TEXT NOT NULL CHECK (amount ~ ${DECIMAL} AND amount !~ '^0+([.]0+)?$'),
  note TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'receipt', 'transfer')),
  personal_category TEXT,
  transfer_id TEXT,
  direction TEXT,
  counterpart_account_id TEXT REFERENCES manual_assets(asset_id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  CHECK (kind = 'purchase' OR personal_category IS NULL),
  CHECK ((kind = 'transfer') = (transfer_id IS NOT NULL AND direction IN ('out', 'in') AND counterpart_account_id IS NOT NULL)),
  CHECK (kind = 'transfer' OR (transfer_id IS NULL AND direction IS NULL AND counterpart_account_id IS NULL)),
  CHECK (counterpart_account_id IS NULL OR counterpart_account_id <> account_id),
  UNIQUE (transfer_id, direction)
);
CREATE INDEX manual_transactions_account ON manual_transactions(account_id, occurred_on);
CREATE TABLE manual_asset_revision (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision BIGINT NOT NULL
);
INSERT INTO manual_asset_revision(singleton, revision) VALUES (TRUE, 0);
`;

/** Every table holding Manual Assets; a Canonical Reset keeps them all (ADR 0087). */
export const MANUAL_ASSET_TABLES = [
  "manual_assets",
  "manual_valuations",
  "manual_transactions",
  "manual_asset_revision",
] as const;

const MANUAL_ASSET_MIGRATIONS = [{ id: "manual-assets-v1", sql: PGLITE_MANUAL_ASSETS_SQL }] as const;

export function applyPgliteManualAssetsSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Manual assets", MANUAL_ASSET_MIGRATIONS, MANUAL_ASSET_TABLES);
}

type Reader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

type AssetRow = {
  asset_id: string; category: ManualAssetCategory; name: string; currency: string; ended_on: string | null; created_at: string;
};
type ValuationRow = {
  asset_id: string; valued_on: string; amount: string; source: ManualValuationSource; note: string | null;
};
type TransactionRow = {
  transaction_id: string; account_id: string; occurred_on: string; amount: string; note: string | null;
  kind: ManualTransaction["kind"]; personal_category: PersonalCategoryCode | null; transfer_id: string | null;
  direction: "out" | "in" | null; counterpart_account_id: string | null;
};

const asset = (row: AssetRow): ManualAsset => ({
  id: row.asset_id,
  category: row.category,
  name: row.name,
  currency: row.currency,
  endedOn: row.ended_on,
  createdAt: row.created_at,
});

const valuation = (row: ValuationRow): ManualValuation => ({
  valuedOn: row.valued_on, amount: row.amount, source: row.source, note: row.note,
});

function transaction(row: TransactionRow): ManualTransaction {
  const core = { id: row.transaction_id, accountId: row.account_id, occurredOn: row.occurred_on, amount: row.amount, note: row.note };
  if (row.kind === "purchase") return { ...core, kind: "purchase", personalCategory: row.personal_category };
  if (row.kind === "receipt") return { ...core, kind: "receipt" };
  return {
    ...core,
    kind: "transfer",
    direction: row.direction!,
    transferId: row.transfer_id!,
    counterpartAccountId: row.counterpart_account_id!,
  };
}

/** One Manual Asset with every valuation and, for a Manual Account, every transaction, oldest first. */
export type ManualAssetView = Readonly<{
  asset: ManualAsset;
  valuations: readonly ManualValuation[];
  transactions: readonly ManualTransaction[];
}>;

export async function readManualAssets(reader: Reader): Promise<readonly ManualAssetView[]> {
  const assets = await reader.query<AssetRow>(
    "SELECT asset_id, category, name, currency, ended_on, created_at FROM manual_assets ORDER BY created_at, asset_id",
  );
  if (assets.rows.length === 0) return [];
  const valuations = await reader.query<ValuationRow>(
    "SELECT asset_id, valued_on, amount, source, note FROM manual_valuations ORDER BY asset_id, valued_on",
  );
  const transactions = await reader.query<TransactionRow>(
    `SELECT transaction_id, account_id, occurred_on, amount, note, kind, personal_category, transfer_id, direction,
            counterpart_account_id
       FROM manual_transactions ORDER BY account_id, occurred_on, recorded_at, transaction_id`,
  );
  return assets.rows.map((row) => ({
    asset: asset(row),
    valuations: valuations.rows.filter((entry) => entry.asset_id === row.asset_id).map(valuation),
    transactions: transactions.rows.filter((entry) => entry.account_id === row.asset_id).map(transaction),
  }));
}

/** Changes on every manual write, deletes included, so a live view can depend on one row. */
export async function readManualAssetRevision(reader: Reader): Promise<number> {
  const result = await reader.query<{ revision: number | string }>("SELECT revision FROM manual_asset_revision");
  return Number(result.rows[0]?.revision ?? 0);
}

/** Only `purchase` rows are spending; receipts and transfers never are. An ended account's purchases stay history. */
export async function readManualSpendingPurchases(reader: Reader): Promise<readonly ManualSpendingPurchase[]> {
  const result = await reader.query<{
    transaction_id: string; account_id: string; name: string; occurred_on: string; amount: string; currency: string;
    personal_category: PersonalCategoryCode | null; note: string | null;
  }>(
    `SELECT tx.transaction_id, tx.account_id, account.name, tx.occurred_on, tx.amount, account.currency,
            tx.personal_category, tx.note
       FROM manual_transactions tx
       JOIN manual_assets account ON account.asset_id = tx.account_id
      WHERE tx.kind = 'purchase'
      ORDER BY tx.occurred_on DESC, tx.recorded_at DESC, tx.transaction_id`,
  );
  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    accountId: row.account_id,
    accountName: row.name,
    occurredOn: row.occurred_on,
    amount: row.amount,
    currency: row.currency,
    personalCategory: row.personal_category,
    note: row.note,
  }));
}

async function requireAsset(tx: PGliteTransaction, assetId: string): Promise<ManualAsset> {
  const result = await tx.query<AssetRow>(
    "SELECT asset_id, category, name, currency, ended_on, created_at FROM manual_assets WHERE asset_id = $1 FOR UPDATE",
    [assetId],
  );
  return result.rows[0] ? asset(result.rows[0]) : reject("asset_not_found", "the manual asset does not exist");
}

function assertBeforeEnd(target: ManualAsset, day: string, what: string): void {
  if (target.endedOn !== null && day > target.endedOn) reject("dated_after_end", `${what} is dated after the asset ended`);
}

async function requireManualAccount(tx: PGliteTransaction, accountId: string): Promise<ManualAsset> {
  const account = await requireAsset(tx, accountId);
  if (!MANUAL_ASSET_CATEGORIES[account.category].recordsTransactions) reject("not_manual_account", "only a Manual Account takes transactions");
  return account;
}

async function insertTransaction(
  tx: PGliteTransaction,
  transactionId: string,
  accountId: string,
  input: ManualTransactionInput,
  recordedAt: string,
): Promise<void> {
  const account = await requireManualAccount(tx, accountId);
  assertBeforeEnd(account, input.occurredOn, "the transaction");
  const insert = (id: string, owner: string, extra: {
    personalCategory?: string | null; transferId?: string; direction?: "out" | "in"; counterpart?: string;
  }) => tx.query(
    `INSERT INTO manual_transactions(transaction_id, account_id, occurred_on, amount, note, kind, personal_category,
       transfer_id, direction, counterpart_account_id, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, owner, input.occurredOn, input.amount, input.note, input.kind, extra.personalCategory ?? null,
      extra.transferId ?? null, extra.direction ?? null, extra.counterpart ?? null, recordedAt],
  );
  if (input.kind === "purchase") {
    await insert(transactionId, accountId, { personalCategory: input.personalCategory });
    return;
  }
  if (input.kind === "receipt") {
    await insert(transactionId, accountId, {});
    return;
  }
  if (input.counterpartAccountId === accountId) reject("transfer_same_account", "a transfer needs two different Manual Accounts");
  const counterpart = await requireManualAccount(tx, input.counterpartAccountId);
  if (counterpart.currency !== account.currency) reject("transfer_currency_mismatch", "a transfer moves between Manual Accounts of one currency");
  assertBeforeEnd(counterpart, input.occurredOn, "the transfer");
  const transferId = randomUUID();
  await insert(transactionId, accountId, { transferId, direction: input.direction, counterpart: counterpart.id });
  await insert(randomUUID(), counterpart.id, {
    transferId,
    direction: input.direction === "out" ? "in" : "out",
    counterpart: account.id,
  });
}

async function requireTransaction(tx: PGliteTransaction, transactionId: string): Promise<TransactionRow> {
  const result = await tx.query<TransactionRow>(
    `SELECT transaction_id, account_id, occurred_on, amount, note, kind, personal_category, transfer_id, direction,
            counterpart_account_id
       FROM manual_transactions WHERE transaction_id = $1`,
    [transactionId],
  );
  return result.rows[0] ?? reject("transaction_not_found", "the manual transaction does not exist");
}

async function deleteTransactionRows(tx: PGliteTransaction, row: TransactionRow): Promise<void> {
  if (row.transfer_id !== null) await tx.query("DELETE FROM manual_transactions WHERE transfer_id = $1", [row.transfer_id]);
  else await tx.query("DELETE FROM manual_transactions WHERE transaction_id = $1", [row.transaction_id]);
}

async function bumpRevision(tx: PGliteTransaction): Promise<number> {
  const result = await tx.query<{ revision: number | string }>(
    "UPDATE manual_asset_revision SET revision = revision + 1 RETURNING revision",
  );
  return Number(result.rows[0]!.revision);
}

async function latestDatedRow(tx: PGliteTransaction, assetId: string): Promise<string | null> {
  const result = await tx.query<{ latest: string | null }>(
    `SELECT GREATEST(
       (SELECT MAX(valued_on) FROM manual_valuations WHERE asset_id = $1),
       (SELECT MAX(occurred_on) FROM manual_transactions WHERE account_id = $1)
     ) AS latest`,
    [assetId],
  );
  return result.rows[0]?.latest ?? null;
}

async function run(
  tx: PGliteTransaction,
  command: ManualAssetCommand,
  now: string,
): Promise<Readonly<{ assetId?: string; transactionId?: string }>> {
  switch (command.kind) {
    case "createAsset": {
      const assetId = randomUUID();
      await tx.query(
        "INSERT INTO manual_assets(asset_id, category, name, currency, ended_on, created_at) VALUES ($1, $2, $3, $4, NULL, $5)",
        [assetId, command.category, command.name, command.currency, now],
      );
      const first = command.firstValuation;
      await tx.query(
        `INSERT INTO manual_valuations(asset_id, valued_on, amount, source, note, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [assetId, first.valuedOn, first.amount, first.source, first.note, now],
      );
      return { assetId };
    }
    case "renameAsset":
      await requireAsset(tx, command.assetId);
      await tx.query("UPDATE manual_assets SET name = $2 WHERE asset_id = $1", [command.assetId, command.name]);
      return { assetId: command.assetId };
    case "endAsset": {
      await requireAsset(tx, command.assetId);
      if (command.endedOn !== null) {
        const latest = await latestDatedRow(tx, command.assetId);
        if (latest !== null && latest > command.endedOn) reject("ends_before_existing_row", "the asset has a valuation or transaction after that end date");
      }
      await tx.query("UPDATE manual_assets SET ended_on = $2 WHERE asset_id = $1", [command.assetId, command.endedOn]);
      return { assetId: command.assetId };
    }
    case "deleteAsset":
      await requireAsset(tx, command.assetId);
      await tx.query("DELETE FROM manual_assets WHERE asset_id = $1", [command.assetId]);
      return { assetId: command.assetId };
    case "upsertValuation": {
      const target = await requireAsset(tx, command.assetId);
      assertSourceAllowed(target.category, command.valuation.source);
      assertBeforeEnd(target, command.valuation.valuedOn, "the valuation");
      const entry = command.valuation;
      await tx.query(
        `INSERT INTO manual_valuations(asset_id, valued_on, amount, source, note, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(asset_id, valued_on) DO UPDATE SET
           amount = EXCLUDED.amount, source = EXCLUDED.source, note = EXCLUDED.note, recorded_at = EXCLUDED.recorded_at`,
        [command.assetId, entry.valuedOn, entry.amount, entry.source, entry.note, now],
      );
      return { assetId: command.assetId };
    }
    case "deleteValuation": {
      await requireAsset(tx, command.assetId);
      const remaining = await tx.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM manual_valuations WHERE asset_id = $1 AND valued_on <> $2",
        [command.assetId, command.valuedOn],
      );
      if (remaining.rows[0]!.count === 0) reject("last_valuation", "an asset keeps at least one valuation; delete the asset instead");
      const deleted = await tx.query(
        "DELETE FROM manual_valuations WHERE asset_id = $1 AND valued_on = $2",
        [command.assetId, command.valuedOn],
      );
      if ((deleted.affectedRows ?? 0) === 0) reject("valuation_not_found", "the valuation does not exist");
      return { assetId: command.assetId };
    }
    case "addTransaction": {
      const transactionId = randomUUID();
      await insertTransaction(tx, transactionId, command.accountId, command.transaction, now);
      return { assetId: command.accountId, transactionId };
    }
    case "updateTransaction": {
      // An edit replaces the row, both sides of a transfer included, from the account it was opened on.
      const existing = await requireTransaction(tx, command.transactionId);
      await deleteTransactionRows(tx, existing);
      await insertTransaction(tx, existing.transaction_id, existing.account_id, command.transaction, now);
      return { assetId: existing.account_id, transactionId: command.transactionId };
    }
    case "deleteTransaction": {
      const existing = await requireTransaction(tx, command.transactionId);
      await deleteTransactionRows(tx, existing);
      return { assetId: existing.account_id, transactionId: command.transactionId };
    }
    case "deleteAllManualAssets":
      await tx.query("DELETE FROM manual_assets");
      return {};
  }
}

export type ManualAssetClock = Readonly<{
  /** The instant a row is recorded at. */
  now(): string;
  /** The person's local calendar date; nothing may be dated after it. */
  today(): string;
}>;

const SYSTEM_CLOCK: ManualAssetClock = {
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
};

/**
 * Parses one command at the boundary, runs it in one transaction, and
 * advances the revision every live view watches. A broken rule rolls the
 * transaction back and comes back as its code, not as a thrown error.
 */
export async function applyManualAssetCommand(
  store: PGliteStore,
  input: unknown,
  clock: ManualAssetClock = SYSTEM_CLOCK,
): Promise<ManualAssetCommandResult> {
  try {
    const command = parseManualAssetCommand(input);
    assertNotFuture(command, clock.today());
    return await store.transaction(async (tx) => {
      const result = await run(tx, command, clock.now());
      return { ok: true as const, ...result, revision: await bumpRevision(tx) };
    });
  } catch (error) {
    if (error instanceof ManualAssetRejected) return { ok: false, code: error.code };
    throw error;
  }
}
