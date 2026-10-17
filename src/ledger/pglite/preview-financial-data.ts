import { createHash } from "node:crypto";
import type { InstitutionKey } from "../../lib/institutions/institutions.ts";
import { isInstitutionKey } from "../../lib/institutions/institutions.ts";
import { PREVIEW_SOURCE_ID } from "../../lib/preview-sources/source-id.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

export type PreviewProduct = "deposit";


export type PreviewAmount = string;

export type PreviewCurrency = string;

export type PreviewLocalDate = Readonly<
  | { precision: "day"; value: string }
  | { precision: "minute"; value: string }
  | { precision: "second"; value: string }
>;

export type PreviewObservedAt = Readonly<{ at: string; source: "reported" | "collection-time" }>;

export type PreviewBalanceObservation = Readonly<{
  kind: "current" | "available";
  amount: PreviewAmount;
  currency: PreviewCurrency;
  observedAt: PreviewObservedAt;
}>;

export type PreviewTransaction = Readonly<{
  sourceRowKey: string;
  amount: PreviewAmount;
  currency: PreviewCurrency;
  direction: "inflow" | "outflow" | "unknown";
  postedAt: PreviewLocalDate;
  description: string | null;
}>;

export type PreviewAccount = Readonly<{
  sourceAccountKey: string;
  displayLabel: string;
  currency: PreviewCurrency;
  type: "depository";
  balances: readonly PreviewBalanceObservation[];
  transactions: readonly PreviewTransaction[];
}>;

export type PreviewCollection = Readonly<{
  collectedAt: string;
  accounts: readonly PreviewAccount[];
}>;

export type PreviewWrite = Readonly<{
  sourceId: string;
  institution: InstitutionKey;
  product: PreviewProduct;
  collection: PreviewCollection;
}>;

export type PreviewWriteReceipt = Readonly<{ accounts: number; balances: number; transactions: number }>;

export type PreviewVisibility = Readonly<{ sourceIds: readonly string[] }>;

export type PreviewAccountView = Readonly<{
  previewAccountId: string;
  sourceId: string;
  institution: InstitutionKey;
  product: PreviewProduct;
  displayLabel: string;
  currency: PreviewCurrency;
  type: "depository";
  lastCollectedAt: string;
  latestBalance: PreviewBalanceObservation | null;
}>;

export type PreviewTransactionView = PreviewTransaction & Readonly<{ previewAccountId: string }>;

export type PGlitePreviewFinancialDataPort = Readonly<{
  write(input: PreviewWrite): Promise<PreviewWriteReceipt>;
  deleteAll(): Promise<void>;
  accounts(visibility: PreviewVisibility): Promise<readonly PreviewAccountView[]>;
  transactions(visibility: PreviewVisibility, previewAccountId: string): Promise<readonly PreviewTransactionView[]>;
}>;

const AMOUNT = /^[+-]?\d+(?:\.\d+)?$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const LOCAL_DATE: Readonly<Record<PreviewLocalDate["precision"], RegExp>> = {
  day: /^\d{4}-\d{2}-\d{2}$/u,
  minute: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u,
  second: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u,
};

export const PGLITE_PREVIEW_FINANCIAL_DATA_SQL = String.raw`
CREATE TABLE preview_accounts (
  preview_account_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  institution_key TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product = 'deposit'),
  source_account_key TEXT NOT NULL,
  display_label TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_type TEXT NOT NULL CHECK (account_type = 'depository'),
  first_collected_at TEXT NOT NULL,
  last_collected_at TEXT NOT NULL,
  UNIQUE (source_id, source_account_key)
);
CREATE TABLE preview_balance_observations (
  preview_account_id TEXT NOT NULL REFERENCES preview_accounts(preview_account_id) ON DELETE CASCADE,
  balance_kind TEXT NOT NULL CHECK (balance_kind IN ('current', 'available')),
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  observed_at TEXT NOT NULL,
  observed_at_reported BOOLEAN NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, balance_kind, observed_at)
);
CREATE TABLE preview_transactions (
  preview_account_id TEXT NOT NULL REFERENCES preview_accounts(preview_account_id) ON DELETE CASCADE,
  source_row_key TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow', 'unknown')),
  posted_at TEXT NOT NULL,
  posted_at_precision TEXT NOT NULL CHECK (posted_at_precision IN ('day', 'minute', 'second')),
  description TEXT,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, source_row_key)
);
`;

export const PREVIEW_FINANCIAL_DATA_TABLES = [
  "preview_accounts",
  "preview_balance_observations",
  "preview_transactions",
] as const;

const PREVIEW_MIGRATION_ID = "preview-financial-data-v1";
const PREVIEW_MIGRATION_SIGNATURE = createHash("sha256").update(PGLITE_PREVIEW_FINANCIAL_DATA_SQL).digest("hex");

export async function applyPglitePreviewFinancialDataSchema(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pglite_operational_migrations (
      migration_key TEXT PRIMARY KEY,
      schema_signature TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const installed = await transaction.query<{ schema_signature: string }>(
      "SELECT schema_signature FROM pglite_operational_migrations WHERE migration_key=$1",
      [PREVIEW_MIGRATION_ID],
    );
    if (installed.rows[0]) {
      if (installed.rows[0].schema_signature !== PREVIEW_MIGRATION_SIGNATURE)
        throw new Error("Preview financial data migration signature has changed.");
      return;
    }
    const prior = await transaction.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [PREVIEW_FINANCIAL_DATA_TABLES],
    );
    if (prior.rows.length > 0)
      throw new Error("Preview financial data tables exist without a migration record.");
    await transaction.exec(PGLITE_PREVIEW_FINANCIAL_DATA_SQL);
    await transaction.query(
      "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
      [PREVIEW_MIGRATION_ID, PREVIEW_MIGRATION_SIGNATURE],
    );
  });
}

export class PreviewDataRejected extends Error {
  constructor(reason: string) {
    super(`Preview data rejected: ${reason}`);
    this.name = "PreviewDataRejected";
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PreviewDataRejected(`${field} is missing`);
  return value;
}

function currency(value: unknown, field: string): string {
  if (typeof value !== "string" || !CURRENCY.test(value)) throw new PreviewDataRejected(`${field} is not an ISO 4217 code`);
  return value;
}

function amount(value: unknown, field: string): string {
  if (typeof value !== "string" || !AMOUNT.test(value)) throw new PreviewDataRejected(`${field} is not an exact decimal string`);
  return value;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new PreviewDataRejected(`${field} is not a timestamp`);
  return value;
}

function list(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new PreviewDataRejected(`${field} is not a list`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new PreviewDataRejected(`${field} is not one of ${allowed.join(", ")}`);
  return value as T;
}

export function parsePreviewWrite(input: PreviewWrite): PreviewWrite {
  if (!PREVIEW_SOURCE_ID.test(input.sourceId)) throw new PreviewDataRejected("sourceId is invalid");
  if (!isInstitutionKey(input.institution)) throw new PreviewDataRejected("institution is unknown");
  oneOf(input.product, ["deposit"], "product");
  instant(input.collection.collectedAt, "collectedAt");
  list(input.collection.accounts, "accounts");
  const accountKeys = new Set<string>();
  for (const account of input.collection.accounts) {
    nonEmpty(account.sourceAccountKey, "sourceAccountKey");
    if (accountKeys.has(account.sourceAccountKey)) throw new PreviewDataRejected("sourceAccountKey is duplicated");
    accountKeys.add(account.sourceAccountKey);
    nonEmpty(account.displayLabel, "displayLabel");
    currency(account.currency, "account currency");
    oneOf(account.type, ["depository"], "account type");
    list(account.balances, "balances");
    list(account.transactions, "transactions");
    for (const balance of account.balances) {
      oneOf(balance.kind, ["current", "available"], "balance kind");
      amount(balance.amount, "balance amount");
      currency(balance.currency, "balance currency");
      instant(balance.observedAt?.at, "observedAt");
      oneOf(balance.observedAt.source, ["reported", "collection-time"], "observedAt source");
    }
    const rowKeys = new Set<string>();
    for (const transaction of account.transactions) {
      nonEmpty(transaction.sourceRowKey, "sourceRowKey");
      if (rowKeys.has(transaction.sourceRowKey)) throw new PreviewDataRejected("sourceRowKey is duplicated");
      rowKeys.add(transaction.sourceRowKey);
      amount(transaction.amount, "transaction amount");
      currency(transaction.currency, "transaction currency");
      oneOf(transaction.direction, ["inflow", "outflow", "unknown"], "direction");
      const precision = oneOf(transaction.postedAt?.precision, ["day", "minute", "second"], "postedAt precision");
      if (typeof transaction.postedAt.value !== "string" || !LOCAL_DATE[precision].test(transaction.postedAt.value))
        throw new PreviewDataRejected("postedAt does not match its precision");
      if (transaction.description !== null && typeof transaction.description !== "string")
        throw new PreviewDataRejected("description is not text");
    }
  }
  return input;
}

export function previewAccountId(sourceId: string, sourceAccountKey: string): string {
  return createHash("sha256").update(`${sourceId}\u0000${sourceAccountKey}`).digest("hex").slice(0, 32);
}

async function writeAccount(
  transaction: PGliteTransaction,
  input: PreviewWrite,
  account: PreviewAccount,
): Promise<void> {
  const { collectedAt } = input.collection;
  const id = previewAccountId(input.sourceId, account.sourceAccountKey);
  await transaction.query(
    `INSERT INTO preview_accounts(preview_account_id, source_id, institution_key, product,
       source_account_key, display_label, currency, account_type, first_collected_at, last_collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT(preview_account_id) DO UPDATE SET
       institution_key=EXCLUDED.institution_key, product=EXCLUDED.product,
       display_label=EXCLUDED.display_label, currency=EXCLUDED.currency,
       last_collected_at=EXCLUDED.last_collected_at`,
    [id, input.sourceId, input.institution, input.product, account.sourceAccountKey,
      account.displayLabel, account.currency, account.type, collectedAt],
  );
  for (const balance of account.balances) await transaction.query(
    `INSERT INTO preview_balance_observations(preview_account_id, balance_kind, amount, currency,
       observed_at, observed_at_reported, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(preview_account_id, balance_kind, observed_at) DO UPDATE SET
       amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       observed_at_reported=EXCLUDED.observed_at_reported, collected_at=EXCLUDED.collected_at`,
    [id, balance.kind, balance.amount, balance.currency, balance.observedAt.at,
      balance.observedAt.source === "reported", collectedAt],
  );
  for (const row of account.transactions) await transaction.query(
    `INSERT INTO preview_transactions(preview_account_id, source_row_key, amount, currency,
       direction, posted_at, posted_at_precision, description, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(preview_account_id, source_row_key) DO UPDATE SET
       amount=EXCLUDED.amount, currency=EXCLUDED.currency, direction=EXCLUDED.direction,
       posted_at=EXCLUDED.posted_at, posted_at_precision=EXCLUDED.posted_at_precision,
       description=EXCLUDED.description, collected_at=EXCLUDED.collected_at`,
    [id, row.sourceRowKey, row.amount, row.currency, row.direction, row.postedAt.value,
      row.postedAt.precision, row.description, collectedAt],
  );
}

type AccountRow = {
  preview_account_id: string; source_id: string; institution_key: InstitutionKey;
  product: PreviewProduct; display_label: string; currency: string; last_collected_at: string;
  balance_kind: PreviewBalanceObservation["kind"] | null; amount: string | null;
  balance_currency: string | null; observed_at: string | null; observed_at_reported: boolean | null;
};

type TransactionRow = {
  preview_account_id: string; source_row_key: string; amount: string; currency: string;
  direction: PreviewTransaction["direction"]; posted_at: string;
  posted_at_precision: PreviewLocalDate["precision"]; description: string | null;
};

type BalanceHistoryRow = {
  preview_account_id: string; display_label: string; balance_kind: PreviewBalanceObservation["kind"];
  amount: string; currency: string; observed_at: string; observed_at_reported: boolean;
};

export type PreviewBalanceHistory = Readonly<{
  previewAccountId: string;
  displayLabel: string;
  observations: readonly PreviewBalanceObservation[];
}>;

type PreviewReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

const observedAt = (at: string, reported: boolean): PreviewObservedAt =>
  ({ at, source: reported ? "reported" : "collection-time" });

export async function readPreviewAccounts(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewAccountView[]> {
  if (visibility.sourceIds.length === 0) return [];
  const result = await reader.query<AccountRow>(
    `SELECT account.preview_account_id, account.source_id, account.institution_key, account.product,
            account.display_label, account.currency, account.last_collected_at, latest.balance_kind, latest.amount,
            latest.currency AS balance_currency, latest.observed_at, latest.observed_at_reported
       FROM preview_accounts account
       LEFT JOIN LATERAL (
         SELECT balance_kind, amount, currency, observed_at, observed_at_reported
           FROM preview_balance_observations balance
          WHERE balance.preview_account_id = account.preview_account_id
          ORDER BY balance_kind = 'current' DESC, observed_at DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE account.source_id = ANY($1::text[])
      ORDER BY account.source_id, account.display_label, account.preview_account_id`,
    [visibility.sourceIds],
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    sourceId: row.source_id,
    institution: row.institution_key,
    product: row.product,
    displayLabel: row.display_label,
    currency: row.currency,
    type: "depository" as const,
    lastCollectedAt: row.last_collected_at,
    latestBalance: row.balance_kind === null ? null : {
      kind: row.balance_kind,
      amount: row.amount!,
      currency: row.balance_currency!,
      observedAt: observedAt(row.observed_at!, row.observed_at_reported === true),
    },
  }));
}

export async function readPreviewTransactions(
  reader: PreviewReader,
  visibility: PreviewVisibility,
  previewAccountId: string,
): Promise<readonly PreviewTransactionView[]> {
  if (visibility.sourceIds.length === 0) return [];
  const result = await reader.query<TransactionRow>(
    `SELECT row.preview_account_id, row.source_row_key, row.amount, row.currency, row.direction,
            row.posted_at, row.posted_at_precision, row.description
       FROM preview_transactions row
       JOIN preview_accounts account ON account.preview_account_id = row.preview_account_id
      WHERE account.source_id = ANY($1::text[]) AND row.preview_account_id = $2
      ORDER BY row.posted_at DESC, row.source_row_key`,
    [visibility.sourceIds, previewAccountId],
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    sourceRowKey: row.source_row_key,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction,
    postedAt: { precision: row.posted_at_precision, value: row.posted_at },
    description: row.description,
  }));
}

export async function readPreviewBalanceHistory(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewBalanceHistory[]> {
  if (visibility.sourceIds.length === 0) return [];
  const result = await reader.query<BalanceHistoryRow>(
    `SELECT account.preview_account_id, account.display_label, balance.balance_kind, balance.amount,
            balance.currency, balance.observed_at, balance.observed_at_reported
       FROM preview_accounts account
       JOIN preview_balance_observations balance ON balance.preview_account_id = account.preview_account_id
      WHERE account.source_id = ANY($1::text[])
      ORDER BY account.preview_account_id, balance.observed_at, balance.balance_kind`,
    [visibility.sourceIds],
  );
  const byAccount = new Map<string, { previewAccountId: string; displayLabel: string; observations: PreviewBalanceObservation[] }>();
  for (const row of result.rows) {
    const entry = byAccount.get(row.preview_account_id)
      ?? { previewAccountId: row.preview_account_id, displayLabel: row.display_label, observations: [] };
    entry.observations.push({
      kind: row.balance_kind,
      amount: row.amount,
      currency: row.currency,
      observedAt: observedAt(row.observed_at, row.observed_at_reported),
    });
    byAccount.set(row.preview_account_id, entry);
  }
  return [...byAccount.values()];
}

export function createPGlitePreviewFinancialData(store: PGliteStore): PGlitePreviewFinancialDataPort {
  return Object.freeze({
    async write(input) {
      const write = parsePreviewWrite(input);
      return store.transaction(async (transaction) => {
        for (const account of write.collection.accounts) await writeAccount(transaction, write, account);
        return {
          accounts: write.collection.accounts.length,
          balances: write.collection.accounts.reduce((sum, account) => sum + account.balances.length, 0),
          transactions: write.collection.accounts.reduce((sum, account) => sum + account.transactions.length, 0),
        };
      });
    },
    async deleteAll() {
      await store.query("DELETE FROM preview_accounts");
    },
    accounts: (visibility) => readPreviewAccounts(store, visibility),
    transactions: (visibility, previewAccountId) => readPreviewTransactions(store, visibility, previewAccountId),
  });
}
