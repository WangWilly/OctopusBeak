import { createHash } from "node:crypto";
import type { InstitutionKey } from "../../lib/institutions/institutions.ts";
import { isInstitutionKey } from "../../lib/institutions/institutions.ts";
import { PREVIEW_SOURCE_ID } from "../../lib/preview-sources/source-id.ts";
import {
  amount,
  currency,
  instant,
  list,
  localDate,
  nonEmpty,
  observedAt,
  oneOf,
  optionalAmount,
  optionalDateOnly,
  optionalText,
  PreviewDataRejected,
  unique,
  visibilityParams,
  visiblePredicate,
  type PreviewAmount,
  type PreviewCurrency,
  type PreviewDirection,
  type PreviewLocalDate,
  type PreviewObservedAt,
  type PreviewProduct,
  type PreviewReader,
  type PreviewVisibility,
} from "./preview-core.ts";
import {
  parsePreviewCreditCollection,
  PGLITE_PREVIEW_CREDIT_SQL,
  PREVIEW_CREDIT_TABLES,
  readPreviewCreditAccounts,
  readPreviewPurchases,
  readPreviewStatements,
  writePreviewCreditAccount,
  type PreviewCreditAccountView,
  type PreviewCreditCollection,
  type PreviewPurchaseView,
  type PreviewStatementView,
} from "./preview-credit.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

export type {
  PreviewAmount,
  PreviewCurrency,
  PreviewDirection,
  PreviewLocalDate,
  PreviewObservedAt,
  PreviewProduct,
  PreviewVisibility,
  PreviewVisibleProduct,
} from "./preview-core.ts";
export { isPreviewProduct, NO_PREVIEW_VISIBILITY, PREVIEW_PRODUCTS, PreviewDataRejected } from "./preview-core.ts";
export type {
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditAccountView,
  PreviewCreditBalance,
  PreviewCreditBasis,
  PreviewCreditCollection,
  PreviewPurchase,
  PreviewPurchasePosting,
  PreviewPurchaseView,
  PreviewStatement,
  PreviewStatementView,
} from "./preview-credit.ts";

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
  direction: PreviewDirection;
  postedAt: PreviewLocalDate;
  description: string | null;
}>;

/** A demand deposit account of the `deposit` product. */
export type PreviewAccount = Readonly<{
  sourceAccountKey: string;
  displayLabel: string;
  currency: PreviewCurrency;
  type: "depository";
  balances: readonly PreviewBalanceObservation[];
  transactions: readonly PreviewTransaction[];
}>;

export type PreviewDepositCollection = Readonly<{
  collectedAt: string;
  accounts: readonly PreviewAccount[];
}>;

export type PreviewTimeDeposit = Readonly<{
  sourceAccountKey: string;
  displayLabel: string;
  currency: PreviewCurrency;
  balances: readonly PreviewBalanceObservation[];
  principal: PreviewAmount | null;
  /** Percent per annum as an exact decimal, such as `"1.725"`. */
  interestRate: PreviewAmount | null;
  maturityDate: string | null;
}>;

/**
 * The complete time-deposit list of one source. `completeness` is the
 * source's own claim; a source that cannot show the list complete fails the
 * product instead of building this value.
 */
export type PreviewTimeDepositCollection = Readonly<{
  collectedAt: string;
  completeness: "complete";
  deposits: readonly PreviewTimeDeposit[];
}>;

export type PreviewProductCollection = Readonly<{
  deposit: PreviewDepositCollection;
  credit_card: PreviewCreditCollection;
  time_deposit: PreviewTimeDepositCollection;
}>;

export type PreviewProductWrite<P extends PreviewProduct = PreviewProduct> =
  P extends PreviewProduct ? Readonly<{ product: P; collection: PreviewProductCollection[P] }> : never;

export type PreviewWrite = Readonly<{ sourceId: string; institution: InstitutionKey }> & PreviewProductWrite;

export type PreviewWriteReceipt = Readonly<{
  accounts: number;
  balances: number;
  transactions: number;
  statements: number;
  /** Time deposits closed by this write because the complete list lacked them. */
  closedAccounts: number;
}>;

export type PreviewTimeDepositView = Readonly<{
  principal: PreviewAmount | null;
  interestRate: PreviewAmount | null;
  maturityDate: string | null;
  /** Set once a complete list lacked the deposit; a closed deposit leaves every total. */
  closedAt: string | null;
}>;

export type PreviewAccountView = Readonly<{
  previewAccountId: string;
  sourceId: string;
  institution: InstitutionKey;
  product: "deposit" | "time_deposit";
  displayLabel: string;
  currency: PreviewCurrency;
  type: "depository";
  lastCollectedAt: string;
  latestBalance: PreviewBalanceObservation | null;
  timeDeposit: PreviewTimeDepositView | null;
}>;

export type PreviewTransactionView = PreviewTransaction & Readonly<{ previewAccountId: string }>;

export type PGlitePreviewFinancialDataPort = Readonly<{
  write(input: PreviewWrite): Promise<PreviewWriteReceipt>;
  deleteAll(): Promise<void>;
  accounts(visibility: PreviewVisibility): Promise<readonly PreviewAccountView[]>;
  transactions(visibility: PreviewVisibility, previewAccountId: string): Promise<readonly PreviewTransactionView[]>;
  creditAccounts(visibility: PreviewVisibility): Promise<readonly PreviewCreditAccountView[]>;
  purchases(visibility: PreviewVisibility, previewAccountId: string): Promise<readonly PreviewPurchaseView[]>;
  statements(visibility: PreviewVisibility, previewAccountId: string): Promise<readonly PreviewStatementView[]>;
}>;

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

/** Time deposits join `preview_accounts`; credit cards get their own table set. */
export const PGLITE_PREVIEW_FINANCIAL_DATA_V2_SQL = String.raw`
ALTER TABLE preview_accounts DROP CONSTRAINT preview_accounts_product_check;
ALTER TABLE preview_accounts
  ADD CONSTRAINT preview_accounts_product_check CHECK (product IN ('deposit', 'time_deposit')),
  ADD COLUMN maturity_date TEXT CHECK (maturity_date IS NULL OR maturity_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ADD COLUMN principal TEXT CHECK (principal IS NULL OR principal ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  ADD COLUMN interest_rate TEXT CHECK (interest_rate IS NULL OR interest_rate ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  ADD COLUMN closed_at TEXT,
  ADD CONSTRAINT preview_accounts_time_deposit_fields CHECK (product = 'time_deposit'
    OR (maturity_date IS NULL AND principal IS NULL AND interest_rate IS NULL AND closed_at IS NULL));
${PGLITE_PREVIEW_CREDIT_SQL}`;

export const PREVIEW_FINANCIAL_DATA_TABLES = [
  "preview_accounts",
  "preview_balance_observations",
  "preview_transactions",
  ...PREVIEW_CREDIT_TABLES,
] as const;

const PREVIEW_MIGRATIONS = [
  { id: "preview-financial-data-v1", sql: PGLITE_PREVIEW_FINANCIAL_DATA_SQL },
  { id: "preview-financial-data-v2", sql: PGLITE_PREVIEW_FINANCIAL_DATA_V2_SQL },
] as const;

const signature = (sql: string) => createHash("sha256").update(sql).digest("hex");

export async function applyPglitePreviewFinancialDataSchema(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pglite_operational_migrations (
      migration_key TEXT PRIMARY KEY,
      schema_signature TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const [index, migration] of PREVIEW_MIGRATIONS.entries()) {
      const installed = await transaction.query<{ schema_signature: string }>(
        "SELECT schema_signature FROM pglite_operational_migrations WHERE migration_key=$1",
        [migration.id],
      );
      if (installed.rows[0]) {
        if (installed.rows[0].schema_signature !== signature(migration.sql))
          throw new Error(`Preview financial data migration signature has changed: ${migration.id}`);
        continue;
      }
      if (index === 0) {
        const prior = await transaction.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [PREVIEW_FINANCIAL_DATA_TABLES],
        );
        if (prior.rows.length > 0)
          throw new Error("Preview financial data tables exist without a migration record.");
      }
      await transaction.exec(migration.sql);
      await transaction.query(
        "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
        [migration.id, signature(migration.sql)],
      );
    }
  });
}

function balance(value: PreviewBalanceObservation): PreviewBalanceObservation {
  return {
    kind: oneOf(value.kind, ["current", "available"], "balance kind"),
    amount: amount(value.amount, "balance amount"),
    currency: currency(value.currency, "balance currency"),
    observedAt: {
      at: instant(value.observedAt?.at, "observedAt"),
      source: oneOf(value.observedAt?.source, ["reported", "collection-time"], "observedAt source"),
    },
  };
}

function balances(value: unknown): readonly PreviewBalanceObservation[] {
  list(value, "balances");
  return (value as readonly PreviewBalanceObservation[]).map(balance);
}

function parseDepositCollection(input: PreviewDepositCollection): PreviewDepositCollection {
  instant(input.collectedAt, "collectedAt");
  list(input.accounts, "accounts");
  const accounts = input.accounts.map((account): PreviewAccount => {
    list(account.transactions, "transactions");
    const transactions = account.transactions.map((transaction): PreviewTransaction => ({
      sourceRowKey: nonEmpty(transaction.sourceRowKey, "sourceRowKey"),
      amount: amount(transaction.amount, "transaction amount"),
      currency: currency(transaction.currency, "transaction currency"),
      direction: oneOf(transaction.direction, ["inflow", "outflow", "unknown"], "direction"),
      postedAt: localDate(transaction.postedAt, "postedAt"),
      description: optionalText(transaction.description, "description"),
    }));
    unique(transactions.map((transaction) => transaction.sourceRowKey), "sourceRowKey");
    return {
      sourceAccountKey: nonEmpty(account.sourceAccountKey, "sourceAccountKey"),
      displayLabel: nonEmpty(account.displayLabel, "displayLabel"),
      currency: currency(account.currency, "account currency"),
      type: oneOf(account.type, ["depository"], "account type"),
      balances: balances(account.balances),
      transactions,
    };
  });
  unique(accounts.map((account) => account.sourceAccountKey), "sourceAccountKey");
  return { collectedAt: input.collectedAt, accounts };
}

function parseTimeDepositCollection(input: PreviewTimeDepositCollection): PreviewTimeDepositCollection {
  instant(input.collectedAt, "collectedAt");
  oneOf(input.completeness, ["complete"], "completeness");
  list(input.deposits, "deposits");
  const deposits = input.deposits.map((deposit): PreviewTimeDeposit => ({
    sourceAccountKey: nonEmpty(deposit.sourceAccountKey, "sourceAccountKey"),
    displayLabel: nonEmpty(deposit.displayLabel, "displayLabel"),
    currency: currency(deposit.currency, "deposit currency"),
    balances: balances(deposit.balances),
    principal: optionalAmount(deposit.principal, "principal"),
    interestRate: optionalAmount(deposit.interestRate, "interestRate"),
    maturityDate: optionalDateOnly(deposit.maturityDate, "maturityDate"),
  }));
  unique(deposits.map((deposit) => deposit.sourceAccountKey), "sourceAccountKey");
  return { collectedAt: input.collectedAt, completeness: "complete", deposits };
}

/** The boundary parse for a write arriving over the operational RPC. */
export function parsePreviewWrite(input: PreviewWrite): PreviewWrite {
  if (!PREVIEW_SOURCE_ID.test(input.sourceId)) throw new PreviewDataRejected("sourceId is invalid");
  if (!isInstitutionKey(input.institution)) throw new PreviewDataRejected("institution is unknown");
  const head = { sourceId: input.sourceId, institution: input.institution };
  switch (oneOf(input.product, ["deposit", "credit_card", "time_deposit"], "product")) {
    case "deposit":
      return { ...head, product: "deposit", collection: parseDepositCollection(input.collection as PreviewDepositCollection) };
    case "credit_card":
      return { ...head, product: "credit_card", collection: parsePreviewCreditCollection(input.collection as PreviewCreditCollection) };
    case "time_deposit":
      return { ...head, product: "time_deposit", collection: parseTimeDepositCollection(input.collection as PreviewTimeDepositCollection) };
  }
}

export function previewAccountId(sourceId: string, sourceAccountKey: string): string {
  return createHash("sha256").update(`${sourceId}\u0000${sourceAccountKey}`).digest("hex").slice(0, 32);
}

type DepositoryRow = Readonly<{
  product: "deposit" | "time_deposit";
  sourceAccountKey: string;
  displayLabel: string;
  currency: PreviewCurrency;
  balances: readonly PreviewBalanceObservation[];
  timeDeposit: Omit<PreviewTimeDepositView, "closedAt"> | null;
}>;

async function writeDepository(
  transaction: PGliteTransaction,
  source: Readonly<{ sourceId: string; institution: InstitutionKey }>,
  collectedAt: string,
  row: DepositoryRow,
): Promise<string> {
  const id = previewAccountId(source.sourceId, row.sourceAccountKey);
  await transaction.query(
    `INSERT INTO preview_accounts(preview_account_id, source_id, institution_key, product, source_account_key,
       display_label, currency, account_type, first_collected_at, last_collected_at,
       maturity_date, principal, interest_rate, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'depository', $8, $8, $9, $10, $11, NULL)
     ON CONFLICT(preview_account_id) DO UPDATE SET
       institution_key=EXCLUDED.institution_key, product=EXCLUDED.product,
       display_label=EXCLUDED.display_label, currency=EXCLUDED.currency,
       last_collected_at=EXCLUDED.last_collected_at,
       maturity_date=EXCLUDED.maturity_date, principal=EXCLUDED.principal, interest_rate=EXCLUDED.interest_rate,
       closed_at=NULL`,
    [id, source.sourceId, source.institution, row.product, row.sourceAccountKey, row.displayLabel, row.currency,
      collectedAt, row.timeDeposit?.maturityDate ?? null, row.timeDeposit?.principal ?? null,
      row.timeDeposit?.interestRate ?? null],
  );
  for (const observation of row.balances) await transaction.query(
    `INSERT INTO preview_balance_observations(preview_account_id, balance_kind, amount, currency,
       observed_at, observed_at_reported, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(preview_account_id, balance_kind, observed_at) DO UPDATE SET
       amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       observed_at_reported=EXCLUDED.observed_at_reported, collected_at=EXCLUDED.collected_at`,
    [id, observation.kind, observation.amount, observation.currency, observation.observedAt.at,
      observation.observedAt.source === "reported", collectedAt],
  );
  return id;
}

async function writeTransactions(
  transaction: PGliteTransaction,
  id: string,
  collectedAt: string,
  rows: readonly PreviewTransaction[],
): Promise<void> {
  for (const row of rows) await transaction.query(
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

const sum = <T>(items: readonly T[], count: (item: T) => number) => items.reduce((total, item) => total + count(item), 0);

async function writeInTransaction(transaction: PGliteTransaction, write: PreviewWrite): Promise<PreviewWriteReceipt> {
  const source = { sourceId: write.sourceId, institution: write.institution };
  switch (write.product) {
    case "deposit": {
      const { collectedAt, accounts } = write.collection;
      for (const account of accounts) {
        const id = await writeDepository(transaction, source, collectedAt, { ...account, product: "deposit", timeDeposit: null });
        await writeTransactions(transaction, id, collectedAt, account.transactions);
      }
      return {
        accounts: accounts.length,
        balances: sum(accounts, (account) => account.balances.length),
        transactions: sum(accounts, (account) => account.transactions.length),
        statements: 0,
        closedAccounts: 0,
      };
    }
    case "credit_card": {
      const { collectedAt, accounts } = write.collection;
      for (const account of accounts) await writePreviewCreditAccount(transaction, source, collectedAt, account);
      return {
        accounts: accounts.length,
        balances: sum(accounts, (account) => account.balances.length),
        transactions: sum(accounts, (account) => account.purchases.length),
        statements: sum(accounts, (account) => account.statements.length),
        closedAccounts: 0,
      };
    }
    case "time_deposit": {
      const { collectedAt, deposits } = write.collection;
      for (const deposit of deposits) await writeDepository(transaction, source, collectedAt, {
        ...deposit,
        product: "time_deposit",
        timeDeposit: { principal: deposit.principal, interestRate: deposit.interestRate, maturityDate: deposit.maturityDate },
      });
      // Preview Time Deposit Closure: the list is complete, so an open deposit it lacks has matured or ended.
      const closed = await transaction.query(
        `UPDATE preview_accounts SET closed_at = $2
          WHERE source_id = $1 AND product = 'time_deposit' AND closed_at IS NULL
            AND NOT (source_account_key = ANY($3::text[]))`,
        [source.sourceId, collectedAt, deposits.map((deposit) => deposit.sourceAccountKey)],
      );
      return {
        accounts: deposits.length,
        balances: sum(deposits, (deposit) => deposit.balances.length),
        transactions: 0,
        statements: 0,
        closedAccounts: closed.affectedRows ?? 0,
      };
    }
  }
}

type AccountRow = {
  preview_account_id: string; source_id: string; institution_key: InstitutionKey;
  product: "deposit" | "time_deposit"; display_label: string; currency: string; last_collected_at: string;
  maturity_date: string | null; principal: string | null; interest_rate: string | null; closed_at: string | null;
  balance_kind: PreviewBalanceObservation["kind"] | null; amount: string | null;
  balance_currency: string | null; observed_at: string | null; observed_at_reported: boolean | null;
};

type TransactionRow = {
  preview_account_id: string; source_row_key: string; amount: string; currency: string;
  direction: PreviewDirection; posted_at: string;
  posted_at_precision: PreviewLocalDate["precision"]; description: string | null;
};

type BalanceHistoryRow = {
  preview_account_id: string; display_label: string; closed_at: string | null;
  balance_kind: PreviewBalanceObservation["kind"];
  amount: string; currency: string; observed_at: string; observed_at_reported: boolean;
};

export type PreviewBalanceHistory = Readonly<{
  previewAccountId: string;
  displayLabel: string;
  closedAt: string | null;
  observations: readonly PreviewBalanceObservation[];
}>;

const DEPOSITORY_VISIBLE = visiblePredicate("account.source_id", "account.product", 1, 2);

export async function readPreviewAccounts(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewAccountView[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<AccountRow>(
    `SELECT account.preview_account_id, account.source_id, account.institution_key, account.product,
            account.display_label, account.currency, account.last_collected_at,
            account.maturity_date, account.principal, account.interest_rate, account.closed_at,
            latest.balance_kind, latest.amount,
            latest.currency AS balance_currency, latest.observed_at, latest.observed_at_reported
       FROM preview_accounts account
       LEFT JOIN LATERAL (
         SELECT balance_kind, amount, currency, observed_at, observed_at_reported
           FROM preview_balance_observations balance
          WHERE balance.preview_account_id = account.preview_account_id
          ORDER BY balance_kind = 'current' DESC, observed_at DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE ${DEPOSITORY_VISIBLE}
      ORDER BY account.source_id, account.display_label, account.preview_account_id`,
    visibilityParams(visibility),
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
    timeDeposit: row.product === "time_deposit"
      ? { principal: row.principal, interestRate: row.interest_rate, maturityDate: row.maturity_date, closedAt: row.closed_at }
      : null,
  }));
}

export async function readPreviewTransactions(
  reader: PreviewReader,
  visibility: PreviewVisibility,
  previewAccountId: string,
): Promise<readonly PreviewTransactionView[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<TransactionRow>(
    `SELECT row.preview_account_id, row.source_row_key, row.amount, row.currency, row.direction,
            row.posted_at, row.posted_at_precision, row.description
       FROM preview_transactions row
       JOIN preview_accounts account ON account.preview_account_id = row.preview_account_id
      WHERE ${DEPOSITORY_VISIBLE} AND row.preview_account_id = $3
      ORDER BY row.posted_at DESC, row.source_row_key`,
    [...visibilityParams(visibility), previewAccountId],
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
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<BalanceHistoryRow>(
    `SELECT account.preview_account_id, account.display_label, account.closed_at, balance.balance_kind, balance.amount,
            balance.currency, balance.observed_at, balance.observed_at_reported
       FROM preview_accounts account
       JOIN preview_balance_observations balance ON balance.preview_account_id = account.preview_account_id
      WHERE ${DEPOSITORY_VISIBLE}
      ORDER BY account.preview_account_id, balance.observed_at, balance.balance_kind`,
    visibilityParams(visibility),
  );
  const byAccount = new Map<string, { previewAccountId: string; displayLabel: string; closedAt: string | null; observations: PreviewBalanceObservation[] }>();
  for (const row of result.rows) {
    const entry = byAccount.get(row.preview_account_id)
      ?? { previewAccountId: row.preview_account_id, displayLabel: row.display_label, closedAt: row.closed_at, observations: [] };
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
      return store.transaction((transaction) => writeInTransaction(transaction, write));
    },
    async deleteAll() {
      await store.transaction(async (transaction) => {
        await transaction.query("DELETE FROM preview_accounts");
        await transaction.query("DELETE FROM preview_credit_accounts");
      });
    },
    accounts: (visibility) => readPreviewAccounts(store, visibility),
    transactions: (visibility, previewAccountId) => readPreviewTransactions(store, visibility, previewAccountId),
    creditAccounts: (visibility) => readPreviewCreditAccounts(store, visibility),
    purchases: (visibility, previewAccountId) => readPreviewPurchases(store, visibility, previewAccountId),
    statements: (visibility, previewAccountId) => readPreviewStatements(store, visibility, previewAccountId),
  });
}
