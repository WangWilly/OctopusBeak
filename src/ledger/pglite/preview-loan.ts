import { createHash } from "node:crypto";
import type { InstitutionKey } from "../../lib/institutions/institutions.ts";
import {
  amount,
  currency,
  instant,
  list,
  nonEmpty,
  observedAt,
  oneOf,
  optionalAmount,
  optionalDateOnly,
  PreviewDataRejected,
  unique,
  visibilityParams,
  visiblePredicate,
  type PreviewAmount,
  type PreviewCurrency,
  type PreviewObservedAt,
  type PreviewReader,
  type PreviewVisibility,
} from "./preview-core.ts";
import type { PGliteTransaction } from "./transaction.ts";

export const PREVIEW_LOAN_CATEGORIES = ["housing", "personal", "other"] as const;

/** Set only from the source's own category; never inferred from a name or an amount. */
export type PreviewLoanCategory = (typeof PREVIEW_LOAN_CATEGORIES)[number];

/** The amount still owed, in the loan's currency. */
export type PreviewLoanBalance = Readonly<{
  amount: PreviewAmount;
  observedAt: PreviewObservedAt;
}>;

/** One snapshot of a loan's current terms. A term the source does not report is `null`. */
export type PreviewLoan = Readonly<{
  /** The full loan account number, never a mask. */
  sourceAccountKey: string;
  /** Shows at most the last four digits of the account number. */
  displayLabel: string;
  currency: PreviewCurrency;
  category: PreviewLoanCategory | null;
  outstandingBalance: PreviewLoanBalance;
  originalAmount: PreviewAmount | null;
  /** Percent per annum as an exact decimal, such as `"2.06"`. */
  interestRate: PreviewAmount | null;
  /** The amount due for the current period. */
  paymentAmount: PreviewAmount | null;
  nextPaymentDate: string | null;
  installmentsPaid: number | null;
  installmentsTotal: number | null;
  openedOn: string | null;
  maturityDate: string | null;
}>;

/**
 * The loan list of one source. Only a `complete` list closes the loans it
 * lacks; an `unproven` list writes what it holds and closes nothing.
 */
export type PreviewLoanCollection = Readonly<{
  collectedAt: string;
  completeness: "complete" | "unproven";
  loans: readonly PreviewLoan[];
}>;

export type PreviewLoanTermsView = Omit<PreviewLoan, "sourceAccountKey" | "displayLabel" | "currency" | "outstandingBalance">
  & Readonly<{
    /** Set once a complete list lacked the loan; a closed loan leaves every total. */
    closedAt: string | null;
  }>;

export type PreviewLoanAccountView = Readonly<{
  previewAccountId: string;
  sourceId: string;
  institution: InstitutionKey;
  product: "loan";
  displayLabel: string;
  currency: PreviewCurrency;
  lastCollectedAt: string;
  latestBalance: PreviewLoanBalance & Readonly<{ currency: PreviewCurrency }>;
  loan: PreviewLoanTermsView;
}>;

export type PreviewLoanBalanceHistory = Readonly<{
  previewAccountId: string;
  displayLabel: string;
  closedAt: string | null;
  observations: readonly Readonly<{ amount: PreviewAmount; currency: PreviewCurrency; observedAt: PreviewObservedAt }>[];
}>;

const DECIMAL = "'^[+-]?[0-9]+([.][0-9]+)?$'";
const DATE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";

export const PGLITE_PREVIEW_LOAN_SQL = String.raw`
CREATE TABLE preview_loan_accounts (
  preview_account_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  institution_key TEXT NOT NULL,
  source_account_key TEXT NOT NULL,
  display_label TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  category TEXT CHECK (category IS NULL OR category IN ('housing', 'personal', 'other')),
  original_amount TEXT CHECK (original_amount IS NULL OR original_amount ~ ${DECIMAL}),
  interest_rate TEXT CHECK (interest_rate IS NULL OR interest_rate ~ ${DECIMAL}),
  payment_amount TEXT CHECK (payment_amount IS NULL OR payment_amount ~ ${DECIMAL}),
  next_payment_date TEXT CHECK (next_payment_date IS NULL OR next_payment_date ~ ${DATE}),
  installments_paid INTEGER CHECK (installments_paid IS NULL OR installments_paid >= 0),
  installments_total INTEGER CHECK (installments_total IS NULL OR installments_total >= 0),
  opened_on TEXT CHECK (opened_on IS NULL OR opened_on ~ ${DATE}),
  maturity_date TEXT CHECK (maturity_date IS NULL OR maturity_date ~ ${DATE}),
  first_collected_at TEXT NOT NULL,
  last_collected_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (source_id, source_account_key),
  CHECK (installments_paid IS NULL OR installments_total IS NULL OR installments_paid <= installments_total)
);
CREATE TABLE preview_loan_balance_observations (
  preview_account_id TEXT NOT NULL REFERENCES preview_loan_accounts(preview_account_id) ON DELETE CASCADE,
  amount TEXT NOT NULL CHECK (amount ~ ${DECIMAL}),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  observed_at TEXT NOT NULL,
  observed_at_reported BOOLEAN NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, observed_at)
);
`;

export const PREVIEW_LOAN_TABLES = ["preview_loan_accounts", "preview_loan_balance_observations"] as const;

export function previewLoanAccountId(sourceId: string, sourceAccountKey: string): string {
  return createHash("sha256").update(`${sourceId}\u0000loan\u0000${sourceAccountKey}`).digest("hex").slice(0, 32);
}

/** A run of five or more digits is more of the account number than the interface may show. */
const ACCOUNT_NUMBER_RUN = /\d{5,}/u;

function displayLabel(value: unknown): string {
  const label = nonEmpty(value, "displayLabel");
  if (ACCOUNT_NUMBER_RUN.test(label)) throw new PreviewDataRejected("displayLabel shows more than the last four digits");
  return label;
}

function optionalCount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PreviewDataRejected(`${field} is not a non-negative integer`);
  return value as number;
}

function parseLoan(input: PreviewLoan): PreviewLoan {
  const installmentsPaid = optionalCount(input.installmentsPaid, "installmentsPaid");
  const installmentsTotal = optionalCount(input.installmentsTotal, "installmentsTotal");
  if (installmentsPaid !== null && installmentsTotal !== null && installmentsPaid > installmentsTotal)
    throw new PreviewDataRejected("installmentsPaid exceeds installmentsTotal");
  const balance = input.outstandingBalance as Partial<PreviewLoanBalance> | null | undefined;
  return {
    sourceAccountKey: nonEmpty(input.sourceAccountKey, "sourceAccountKey"),
    displayLabel: displayLabel(input.displayLabel),
    currency: currency(input.currency, "loan currency"),
    category: input.category === null ? null : oneOf(input.category, PREVIEW_LOAN_CATEGORIES, "category"),
    outstandingBalance: {
      amount: amount(balance?.amount, "outstandingBalance"),
      observedAt: {
        at: instant(balance?.observedAt?.at, "observedAt"),
        source: oneOf(balance?.observedAt?.source, ["reported", "collection-time"], "observedAt source"),
      },
    },
    originalAmount: optionalAmount(input.originalAmount, "originalAmount"),
    interestRate: optionalAmount(input.interestRate, "interestRate"),
    paymentAmount: optionalAmount(input.paymentAmount, "paymentAmount"),
    nextPaymentDate: optionalDateOnly(input.nextPaymentDate, "nextPaymentDate"),
    installmentsPaid,
    installmentsTotal,
    openedOn: optionalDateOnly(input.openedOn, "openedOn"),
    maturityDate: optionalDateOnly(input.maturityDate, "maturityDate"),
  };
}

export function parsePreviewLoanCollection(input: PreviewLoanCollection): PreviewLoanCollection {
  instant(input.collectedAt, "collectedAt");
  const completeness = oneOf(input.completeness, ["complete", "unproven"], "completeness");
  list(input.loans, "loans");
  const loans = input.loans.map(parseLoan);
  unique(loans.map((loan) => loan.sourceAccountKey), "sourceAccountKey");
  return { collectedAt: input.collectedAt, completeness, loans };
}

/**
 * Writes one loan snapshot: the terms replace the stored ones, the balance
 * joins the history, and a loan seen again is open again.
 */
async function writeLoan(
  transaction: PGliteTransaction,
  source: Readonly<{ sourceId: string; institution: InstitutionKey }>,
  collectedAt: string,
  loan: PreviewLoan,
): Promise<void> {
  const id = previewLoanAccountId(source.sourceId, loan.sourceAccountKey);
  await transaction.query(
    `INSERT INTO preview_loan_accounts(preview_account_id, source_id, institution_key, source_account_key,
       display_label, currency, category, original_amount, interest_rate, payment_amount, next_payment_date,
       installments_paid, installments_total, opened_on, maturity_date, first_collected_at, last_collected_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, NULL)
     ON CONFLICT(preview_account_id) DO UPDATE SET
       institution_key=EXCLUDED.institution_key, display_label=EXCLUDED.display_label, currency=EXCLUDED.currency,
       category=EXCLUDED.category, original_amount=EXCLUDED.original_amount, interest_rate=EXCLUDED.interest_rate,
       payment_amount=EXCLUDED.payment_amount, next_payment_date=EXCLUDED.next_payment_date,
       installments_paid=EXCLUDED.installments_paid, installments_total=EXCLUDED.installments_total,
       opened_on=EXCLUDED.opened_on, maturity_date=EXCLUDED.maturity_date,
       last_collected_at=EXCLUDED.last_collected_at, closed_at=NULL`,
    [id, source.sourceId, source.institution, loan.sourceAccountKey, loan.displayLabel, loan.currency, loan.category,
      loan.originalAmount, loan.interestRate, loan.paymentAmount, loan.nextPaymentDate, loan.installmentsPaid,
      loan.installmentsTotal, loan.openedOn, loan.maturityDate, collectedAt],
  );
  const balance = loan.outstandingBalance;
  await transaction.query(
    `INSERT INTO preview_loan_balance_observations(preview_account_id, amount, currency, observed_at,
       observed_at_reported, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(preview_account_id, observed_at) DO UPDATE SET
       amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       observed_at_reported=EXCLUDED.observed_at_reported, collected_at=EXCLUDED.collected_at`,
    [id, balance.amount, loan.currency, balance.observedAt.at, balance.observedAt.source === "reported", collectedAt],
  );
}

/** Writes the snapshot and returns how many loans it closed. */
export async function writePreviewLoanCollection(
  transaction: PGliteTransaction,
  source: Readonly<{ sourceId: string; institution: InstitutionKey }>,
  collection: PreviewLoanCollection,
): Promise<number> {
  for (const loan of collection.loans) await writeLoan(transaction, source, collection.collectedAt, loan);
  if (collection.completeness !== "complete") return 0;
  // Like Preview Time Deposit Closure: the list is complete, so an open loan it lacks has been repaid or ended.
  const closed = await transaction.query(
    `UPDATE preview_loan_accounts SET closed_at = $2
      WHERE source_id = $1 AND closed_at IS NULL AND NOT (source_account_key = ANY($3::text[]))`,
    [source.sourceId, collection.collectedAt, collection.loans.map((loan) => loan.sourceAccountKey)],
  );
  return closed.affectedRows ?? 0;
}

type LoanAccountRow = {
  preview_account_id: string; source_id: string; institution_key: InstitutionKey; display_label: string;
  currency: string; category: PreviewLoanCategory | null; original_amount: string | null; interest_rate: string | null;
  payment_amount: string | null; next_payment_date: string | null; installments_paid: number | null;
  installments_total: number | null; opened_on: string | null; maturity_date: string | null;
  last_collected_at: string; closed_at: string | null;
  amount: string; balance_currency: string; observed_at: string; observed_at_reported: boolean;
};

type LoanHistoryRow = {
  preview_account_id: string; display_label: string; closed_at: string | null;
  amount: string; currency: string; observed_at: string; observed_at_reported: boolean;
};

const LOAN_VISIBLE = visiblePredicate("account.source_id", "'loan'", 1, 2);

export async function readPreviewLoanAccounts(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewLoanAccountView[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<LoanAccountRow>(
    `SELECT account.preview_account_id, account.source_id, account.institution_key, account.display_label,
            account.currency, account.category, account.original_amount, account.interest_rate, account.payment_amount,
            account.next_payment_date, account.installments_paid, account.installments_total, account.opened_on,
            account.maturity_date, account.last_collected_at, account.closed_at, latest.amount,
            latest.currency AS balance_currency, latest.observed_at, latest.observed_at_reported
       FROM preview_loan_accounts account
       JOIN LATERAL (
         SELECT amount, currency, observed_at, observed_at_reported
           FROM preview_loan_balance_observations balance
          WHERE balance.preview_account_id = account.preview_account_id
          ORDER BY observed_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE ${LOAN_VISIBLE}
      ORDER BY account.source_id, account.display_label, account.preview_account_id`,
    visibilityParams(visibility),
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    sourceId: row.source_id,
    institution: row.institution_key,
    product: "loan" as const,
    displayLabel: row.display_label,
    currency: row.currency,
    lastCollectedAt: row.last_collected_at,
    latestBalance: {
      amount: row.amount,
      currency: row.balance_currency,
      observedAt: observedAt(row.observed_at, row.observed_at_reported),
    },
    loan: {
      category: row.category,
      originalAmount: row.original_amount,
      interestRate: row.interest_rate,
      paymentAmount: row.payment_amount,
      nextPaymentDate: row.next_payment_date,
      installmentsPaid: row.installments_paid,
      installmentsTotal: row.installments_total,
      openedOn: row.opened_on,
      maturityDate: row.maturity_date,
      closedAt: row.closed_at,
    },
  }));
}

export async function readPreviewLoanBalanceHistory(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewLoanBalanceHistory[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<LoanHistoryRow>(
    `SELECT account.preview_account_id, account.display_label, account.closed_at, balance.amount, balance.currency,
            balance.observed_at, balance.observed_at_reported
       FROM preview_loan_accounts account
       JOIN preview_loan_balance_observations balance ON balance.preview_account_id = account.preview_account_id
      WHERE ${LOAN_VISIBLE}
      ORDER BY account.preview_account_id, balance.observed_at`,
    visibilityParams(visibility),
  );
  const byAccount = new Map<string, { previewAccountId: string; displayLabel: string; closedAt: string | null; observations: PreviewLoanBalanceHistory["observations"][number][] }>();
  for (const row of result.rows) {
    const entry = byAccount.get(row.preview_account_id)
      ?? { previewAccountId: row.preview_account_id, displayLabel: row.display_label, closedAt: row.closed_at, observations: [] };
    entry.observations.push({
      amount: row.amount,
      currency: row.currency,
      observedAt: observedAt(row.observed_at, row.observed_at_reported),
    });
    byAccount.set(row.preview_account_id, entry);
  }
  return [...byAccount.values()];
}
