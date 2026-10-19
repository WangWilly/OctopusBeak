import { createHash } from "node:crypto";
import type { InstitutionKey } from "../../lib/institutions/institutions.ts";
import {
  amount,
  amountKey,
  BILLING_PERIOD,
  currency,
  dateOnly,
  instant,
  list,
  localDate,
  nonEmpty,
  observedAt,
  oneOf,
  optionalAmount,
  optionalDateOnly,
  optionalFlag,
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
  type PreviewReader,
  type PreviewVisibility,
} from "./preview-core.ts";
import type { PGliteTransaction } from "./transaction.ts";

/**
 * How a used-credit amount was obtained, with the exact source operands. A
 * balance cannot be built without one, and no operand defaults to zero.
 */
export type PreviewCreditBasis = Readonly<
  | { kind: "provider-used-credit"; usedCredit: PreviewAmount }
  | { kind: "credit-limit-minus-available"; creditLimit: PreviewAmount; availableCredit: PreviewAmount }
  | { kind: "statement-minus-paid-plus-unbilled"; statementAmount: PreviewAmount; paidAmount: PreviewAmount; unbilledAmount: PreviewAmount }
>;

export type PreviewCreditBasisKind = PreviewCreditBasis["kind"];

/** `credit_used`: positive when owed, negative when overpaid, never clamped. */
export type PreviewCreditBalance = Readonly<{
  amount: PreviewAmount;
  currency: PreviewCurrency;
  observedAt: PreviewObservedAt;
  basis: PreviewCreditBasis;
}>;

export type PreviewCard = Readonly<{
  sourceCardKey: string;
  /** Ends in the card's last four digits, such as `"****-1234"`. */
  cardMask: string;
  displayLabel: string | null;
}>;

export type PreviewPurchasePosting = Readonly<
  | { status: "pending" }
  | { status: "posted"; billing: "billed" | "unbilled"; postingDate: string | null }
>;

export type PreviewPurchase = Readonly<{
  sourceRowKey: string;
  amount: PreviewAmount;
  currency: PreviewCurrency;
  direction: PreviewDirection;
  posting: PreviewPurchasePosting;
  consumedAt: PreviewLocalDate;
  /** Must name one of the account's cards; a purchase without a card never pairs. */
  sourceCardKey: string | null;
  statementKey: string | null;
  bankReference: string | null;
  description: string | null;
}>;

export type PreviewStatement = Readonly<{
  statementKey: string;
  cycleStart: string | null;
  cycleEnd: string | null;
  closingDate: string | null;
  dueDate: string;
  amount: PreviewAmount;
  currency: PreviewCurrency;
  minimumPayment: PreviewAmount | null;
  /** `YYYY-MM`. */
  billingPeriod: string;
  paidAmount: PreviewAmount | null;
  paid: boolean | null;
  noPaymentNeeded: boolean | null;
}>;

export type PreviewCreditAccount = Readonly<{
  sourceAccountKey: string;
  displayLabel: string;
  currency: PreviewCurrency;
  creditLimit: PreviewAmount | null;
  cards: readonly PreviewCard[];
  balances: readonly PreviewCreditBalance[];
  /** The complete current pending and unbilled lists, plus any billed rows read. */
  purchases: readonly PreviewPurchase[];
  statements: readonly PreviewStatement[];
}>;

export type PreviewCreditCollection = Readonly<{
  collectedAt: string;
  accounts: readonly PreviewCreditAccount[];
}>;

export type PreviewCreditRelationKind = "pending_to_posted" | "unbilled_to_billed";

export type PreviewCreditAccountView = Readonly<{
  previewAccountId: string;
  sourceId: string;
  institution: InstitutionKey;
  product: "credit_card";
  displayLabel: string;
  currency: PreviewCurrency;
  creditLimit: PreviewAmount | null;
  cards: readonly PreviewCard[];
  lastCollectedAt: string;
  /** `null` means the used credit is unknown; totals must not treat it as zero. */
  latestBalance: PreviewCreditBalance | null;
}>;

export type PreviewPurchaseView = PreviewPurchase & Readonly<{
  previewAccountId: string;
  /** The paired authorization's consume time, on the posted purchase that replaced it. */
  authorizedAt: PreviewLocalDate | null;
}>;

export type PreviewStatementView = PreviewStatement & Readonly<{ previewAccountId: string }>;

export type PreviewCreditBalanceHistory = Readonly<{
  previewAccountId: string;
  displayLabel: string;
  observations: readonly PreviewCreditBalance[];
}>;

export const PREVIEW_CREDIT_BASIS_KINDS = [
  "provider-used-credit",
  "credit-limit-minus-available",
  "statement-minus-paid-plus-unbilled",
] as const satisfies readonly PreviewCreditBasisKind[];

const CARD_MASK = /[0-9]{4}$/u;

export const PGLITE_PREVIEW_CREDIT_SQL = String.raw`
CREATE TABLE preview_credit_accounts (
  preview_account_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  institution_key TEXT NOT NULL,
  source_account_key TEXT NOT NULL,
  display_label TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credit_limit TEXT CHECK (credit_limit IS NULL OR credit_limit ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  first_collected_at TEXT NOT NULL,
  last_collected_at TEXT NOT NULL,
  UNIQUE (source_id, source_account_key)
);
CREATE TABLE preview_credit_cards (
  preview_account_id TEXT NOT NULL REFERENCES preview_credit_accounts(preview_account_id) ON DELETE CASCADE,
  source_card_key TEXT NOT NULL,
  card_mask TEXT NOT NULL CHECK (card_mask ~ '[0-9][0-9][0-9][0-9]$'),
  display_label TEXT,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, source_card_key)
);
CREATE TABLE preview_credit_balance_observations (
  preview_account_id TEXT NOT NULL REFERENCES preview_credit_accounts(preview_account_id) ON DELETE CASCADE,
  balance_kind TEXT NOT NULL CHECK (balance_kind = 'credit_used'),
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  observed_at TEXT NOT NULL,
  observed_at_reported BOOLEAN NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('provider-used-credit', 'credit-limit-minus-available', 'statement-minus-paid-plus-unbilled')),
  basis_operands TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, observed_at)
);
CREATE TABLE preview_credit_purchases (
  preview_account_id TEXT NOT NULL REFERENCES preview_credit_accounts(preview_account_id) ON DELETE CASCADE,
  source_row_key TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?[0-9]+([.][0-9]+)?$' AND amount !~ '^[+-]?0+([.]0+)?$'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow', 'unknown')),
  posting_status TEXT NOT NULL CHECK (posting_status IN ('pending', 'posted')),
  billing_status TEXT CHECK (billing_status IS NULL OR billing_status IN ('billed', 'unbilled')),
  consumed_at TEXT NOT NULL,
  consumed_at_precision TEXT NOT NULL CHECK (consumed_at_precision IN ('day', 'minute', 'second')),
  posting_date TEXT,
  source_card_key TEXT,
  statement_key TEXT,
  bank_reference TEXT,
  description TEXT,
  first_collected_at TEXT NOT NULL,
  last_collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, source_row_key),
  CHECK ((posting_status = 'pending' AND billing_status IS NULL AND posting_date IS NULL)
      OR (posting_status = 'posted' AND billing_status IS NOT NULL))
);
CREATE TABLE preview_credit_statements (
  preview_account_id TEXT NOT NULL REFERENCES preview_credit_accounts(preview_account_id) ON DELETE CASCADE,
  statement_key TEXT NOT NULL,
  cycle_start TEXT,
  cycle_end TEXT,
  closing_date TEXT,
  due_date TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  minimum_payment TEXT CHECK (minimum_payment IS NULL OR minimum_payment ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  billing_period TEXT NOT NULL CHECK (billing_period ~ '^[0-9]{4}-[0-9]{2}$'),
  paid_amount TEXT CHECK (paid_amount IS NULL OR paid_amount ~ '^[+-]?[0-9]+([.][0-9]+)?$'),
  paid BOOLEAN,
  no_payment_needed BOOLEAN,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, statement_key)
);
CREATE TABLE preview_credit_relations (
  preview_account_id TEXT NOT NULL REFERENCES preview_credit_accounts(preview_account_id) ON DELETE CASCADE,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('pending_to_posted', 'unbilled_to_billed')),
  from_row_key TEXT NOT NULL,
  to_row_key TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (preview_account_id, relation_kind, from_row_key),
  UNIQUE (preview_account_id, relation_kind, to_row_key)
);
`;

export const PREVIEW_CREDIT_TABLES = [
  "preview_credit_accounts",
  "preview_credit_cards",
  "preview_credit_balance_observations",
  "preview_credit_purchases",
  "preview_credit_statements",
  "preview_credit_relations",
] as const;

export function previewCreditAccountId(sourceId: string, sourceAccountKey: string): string {
  return createHash("sha256").update(`${sourceId}\u0000credit_card\u0000${sourceAccountKey}`).digest("hex").slice(0, 32);
}

function basis(value: unknown): PreviewCreditBasis {
  const candidate = value as Partial<Record<string, unknown>> | null | undefined;
  const kind = oneOf(candidate?.kind, PREVIEW_CREDIT_BASIS_KINDS, "basis kind");
  switch (kind) {
    case "provider-used-credit":
      return { kind, usedCredit: amount(candidate?.usedCredit, "basis usedCredit") };
    case "credit-limit-minus-available":
      return {
        kind,
        creditLimit: amount(candidate?.creditLimit, "basis creditLimit"),
        availableCredit: amount(candidate?.availableCredit, "basis availableCredit"),
      };
    case "statement-minus-paid-plus-unbilled":
      return {
        kind,
        statementAmount: amount(candidate?.statementAmount, "basis statementAmount"),
        paidAmount: amount(candidate?.paidAmount, "basis paidAmount"),
        unbilledAmount: amount(candidate?.unbilledAmount, "basis unbilledAmount"),
      };
  }
}

function posting(value: unknown): PreviewPurchasePosting {
  const candidate = value as Partial<Record<string, unknown>> | null | undefined;
  const status = oneOf(candidate?.status, ["pending", "posted"], "posting status");
  if (status === "pending") {
    if (candidate?.billing !== undefined || candidate?.postingDate !== undefined)
      throw new PreviewDataRejected("a pending purchase has no billing status or posting date");
    return { status };
  }
  return {
    status,
    billing: oneOf(candidate?.billing, ["billed", "unbilled"], "billing status"),
    postingDate: optionalDateOnly(candidate?.postingDate, "postingDate"),
  };
}

function parseAccount(input: PreviewCreditAccount): PreviewCreditAccount {
  nonEmpty(input.sourceAccountKey, "sourceAccountKey");
  nonEmpty(input.displayLabel, "displayLabel");
  currency(input.currency, "account currency");
  optionalAmount(input.creditLimit, "creditLimit");
  list(input.cards, "cards");
  list(input.balances, "balances");
  list(input.purchases, "purchases");
  list(input.statements, "statements");
  const cards = input.cards.map((card) => {
    nonEmpty(card.sourceCardKey, "sourceCardKey");
    if (typeof card.cardMask !== "string" || !CARD_MASK.test(card.cardMask)) throw new PreviewDataRejected("cardMask does not end in four digits");
    optionalText(card.displayLabel, "card displayLabel");
    return card;
  });
  unique(cards.map((card) => card.sourceCardKey), "sourceCardKey");
  const cardKeys = new Set(cards.map((card) => card.sourceCardKey));
  const balances = input.balances.map((balance): PreviewCreditBalance => ({
    amount: amount(balance.amount, "balance amount"),
    currency: currency(balance.currency, "balance currency"),
    observedAt: {
      at: instant(balance.observedAt?.at, "observedAt"),
      source: oneOf(balance.observedAt?.source, ["reported", "collection-time"], "observedAt source"),
    },
    basis: basis(balance.basis),
  }));
  const purchases = input.purchases.map((purchase): PreviewPurchase => {
    const value = amount(purchase.amount, "purchase amount");
    if (amountKey(value) === "0") throw new PreviewDataRejected("purchase amount is zero");
    const sourceCardKey = optionalText(purchase.sourceCardKey, "purchase sourceCardKey");
    if (sourceCardKey !== null && !cardKeys.has(sourceCardKey)) throw new PreviewDataRejected("purchase names an unknown card");
    return {
      sourceRowKey: nonEmpty(purchase.sourceRowKey, "sourceRowKey"),
      amount: value,
      currency: currency(purchase.currency, "purchase currency"),
      direction: oneOf(purchase.direction, ["inflow", "outflow", "unknown"], "direction"),
      posting: posting(purchase.posting),
      consumedAt: localDate(purchase.consumedAt, "consumedAt"),
      sourceCardKey,
      statementKey: optionalText(purchase.statementKey, "purchase statementKey"),
      bankReference: optionalText(purchase.bankReference, "bankReference"),
      description: optionalText(purchase.description, "description"),
    };
  });
  unique(purchases.map((purchase) => purchase.sourceRowKey), "sourceRowKey");
  const statements = input.statements.map((statement): PreviewStatement => {
    if (typeof statement.billingPeriod !== "string" || !BILLING_PERIOD.test(statement.billingPeriod))
      throw new PreviewDataRejected("billingPeriod is not YYYY-MM");
    return {
      statementKey: nonEmpty(statement.statementKey, "statementKey"),
      cycleStart: optionalDateOnly(statement.cycleStart, "cycleStart"),
      cycleEnd: optionalDateOnly(statement.cycleEnd, "cycleEnd"),
      closingDate: optionalDateOnly(statement.closingDate, "closingDate"),
      dueDate: dateOnly(statement.dueDate, "dueDate"),
      amount: amount(statement.amount, "statement amount"),
      currency: currency(statement.currency, "statement currency"),
      minimumPayment: optionalAmount(statement.minimumPayment, "minimumPayment"),
      billingPeriod: statement.billingPeriod,
      paidAmount: optionalAmount(statement.paidAmount, "paidAmount"),
      paid: optionalFlag(statement.paid, "paid"),
      noPaymentNeeded: optionalFlag(statement.noPaymentNeeded, "noPaymentNeeded"),
    };
  });
  unique(statements.map((statement) => statement.statementKey), "statementKey");
  return {
    sourceAccountKey: input.sourceAccountKey,
    displayLabel: input.displayLabel,
    currency: input.currency,
    creditLimit: input.creditLimit,
    cards,
    balances,
    purchases,
    statements,
  };
}

export function parsePreviewCreditCollection(input: PreviewCreditCollection): PreviewCreditCollection {
  instant(input.collectedAt, "collectedAt");
  list(input.accounts, "accounts");
  const accounts = input.accounts.map(parseAccount);
  unique(accounts.map((account) => account.sourceAccountKey), "sourceAccountKey");
  return { collectedAt: input.collectedAt, accounts };
}

type StoredPurchase = {
  source_row_key: string; amount: string; currency: string; direction: PreviewDirection;
  posting_status: "pending" | "posted"; billing_status: "billed" | "unbilled" | null;
  consumed_at: string; source_card_key: string | null; bank_reference: string | null;
  first_collected_at: string; last_collected_at: string;
};

type StoredRelation = { relation_kind: PreviewCreditRelationKind; from_row_key: string; to_row_key: string };

type Pair = Readonly<{ from: string; to: string }>;

const byConsumeOrder = (left: StoredPurchase, right: StoredPurchase) =>
  left.consumed_at.localeCompare(right.consumed_at) || left.source_row_key.localeCompare(right.source_row_key);

/** The identity shared by a pending authorization and the posted purchase it became. */
const matchKey = (row: StoredPurchase) =>
  [row.source_card_key, row.consumed_at.slice(0, 10), row.currency, amountKey(row.amount), row.direction].join("\u0000");

function zipByKey(froms: readonly StoredPurchase[], tos: readonly StoredPurchase[]): Pair[] {
  const pending = new Map<string, StoredPurchase[]>();
  for (const row of [...froms].sort(byConsumeOrder)) {
    const key = matchKey(row);
    pending.set(key, [...(pending.get(key) ?? []), row]);
  }
  const pairs: Pair[] = [];
  for (const row of [...tos].sort(byConsumeOrder)) {
    const candidate = pending.get(matchKey(row))?.shift();
    if (candidate) pairs.push({ from: candidate.source_row_key, to: row.source_row_key });
  }
  return pairs;
}

/**
 * Preview Authorization Pairing. A bank reference shared by exactly one
 * pending and one posted candidate wins; otherwise the match key pairs rows
 * in consume-time order, each used once.
 */
export function pairAuthorizations(rows: readonly StoredPurchase[], established: readonly StoredRelation[]): Pair[] {
  const linkedFrom = new Set(established.filter((r) => r.relation_kind === "pending_to_posted").map((r) => r.from_row_key));
  const linkedTo = new Set(established.filter((r) => r.relation_kind === "pending_to_posted").map((r) => r.to_row_key));
  const superseded = new Set(established.filter((r) => r.relation_kind === "unbilled_to_billed").map((r) => r.from_row_key));
  const eligible = rows.filter((row) => row.direction !== "unknown" && row.source_card_key !== null);
  let pendings = eligible.filter((row) => row.posting_status === "pending" && !linkedFrom.has(row.source_row_key));
  let posteds = eligible.filter((row) => row.posting_status === "posted" && !linkedTo.has(row.source_row_key) && !superseded.has(row.source_row_key));

  const pairs: Pair[] = [];
  const references = new Set(pendings.flatMap((row) => row.bank_reference === null ? [] : [row.bank_reference]));
  for (const reference of references) {
    const fromSide = pendings.filter((row) => row.bank_reference === reference);
    const toSide = posteds.filter((row) => row.bank_reference === reference);
    if (fromSide.length !== 1 || toSide.length !== 1) continue;
    pairs.push({ from: fromSide[0]!.source_row_key, to: toSide[0]!.source_row_key });
  }
  const used = new Set(pairs.flatMap((pair) => [pair.from, pair.to]));
  pendings = pendings.filter((row) => !used.has(row.source_row_key));
  posteds = posteds.filter((row) => !used.has(row.source_row_key));
  return [...pairs, ...zipByKey(pendings, posteds)];
}

/**
 * Preview Billing Supersession. An unbilled purchase missing from this
 * collection is replaced by a billed purchase that first appeared in it when
 * the two share the match key.
 */
export function supersedeUnbilled(rows: readonly StoredPurchase[], established: readonly StoredRelation[], collectedAt: string): Pair[] {
  const linkedFrom = new Set(established.filter((r) => r.relation_kind === "unbilled_to_billed").map((r) => r.from_row_key));
  const linkedTo = new Set(established.filter((r) => r.relation_kind === "unbilled_to_billed").map((r) => r.to_row_key));
  const eligible = rows.filter((row) => row.direction !== "unknown" && row.source_card_key !== null && row.posting_status === "posted");
  const vanished = eligible.filter((row) =>
    row.billing_status === "unbilled" && row.last_collected_at !== collectedAt && !linkedFrom.has(row.source_row_key));
  const appeared = eligible.filter((row) =>
    row.billing_status === "billed" && row.first_collected_at === collectedAt && !linkedTo.has(row.source_row_key));
  return zipByKey(vanished, appeared);
}

async function insertRelations(
  transaction: PGliteTransaction,
  accountId: string,
  kind: PreviewCreditRelationKind,
  pairs: readonly Pair[],
  collectedAt: string,
): Promise<void> {
  for (const pair of pairs) await transaction.query(
    `INSERT INTO preview_credit_relations(preview_account_id, relation_kind, from_row_key, to_row_key, collected_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [accountId, kind, pair.from, pair.to, collectedAt],
  );
}

export async function writePreviewCreditAccount(
  transaction: PGliteTransaction,
  source: Readonly<{ sourceId: string; institution: InstitutionKey }>,
  collectedAt: string,
  account: PreviewCreditAccount,
): Promise<void> {
  const id = previewCreditAccountId(source.sourceId, account.sourceAccountKey);
  await transaction.query(
    `INSERT INTO preview_credit_accounts(preview_account_id, source_id, institution_key, source_account_key,
       display_label, currency, credit_limit, first_collected_at, last_collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT(preview_account_id) DO UPDATE SET
       institution_key=EXCLUDED.institution_key, display_label=EXCLUDED.display_label, currency=EXCLUDED.currency,
       credit_limit=COALESCE(EXCLUDED.credit_limit, preview_credit_accounts.credit_limit),
       last_collected_at=EXCLUDED.last_collected_at`,
    [id, source.sourceId, source.institution, account.sourceAccountKey, account.displayLabel,
      account.currency, account.creditLimit, collectedAt],
  );
  for (const card of account.cards) await transaction.query(
    `INSERT INTO preview_credit_cards(preview_account_id, source_card_key, card_mask, display_label, collected_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(preview_account_id, source_card_key) DO UPDATE SET
       card_mask=EXCLUDED.card_mask, display_label=EXCLUDED.display_label, collected_at=EXCLUDED.collected_at`,
    [id, card.sourceCardKey, card.cardMask, card.displayLabel, collectedAt],
  );
  for (const balance of account.balances) {
    const { kind, ...operands } = balance.basis;
    await transaction.query(
      `INSERT INTO preview_credit_balance_observations(preview_account_id, balance_kind, amount, currency,
         observed_at, observed_at_reported, basis, basis_operands, collected_at)
       VALUES ($1, 'credit_used', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(preview_account_id, observed_at) DO UPDATE SET
         amount=EXCLUDED.amount, currency=EXCLUDED.currency, observed_at_reported=EXCLUDED.observed_at_reported,
         basis=EXCLUDED.basis, basis_operands=EXCLUDED.basis_operands, collected_at=EXCLUDED.collected_at`,
      [id, balance.amount, balance.currency, balance.observedAt.at, balance.observedAt.source === "reported",
        kind, JSON.stringify(operands), collectedAt],
    );
  }
  for (const purchase of account.purchases) {
    const posted = purchase.posting.status === "posted" ? purchase.posting : null;
    await transaction.query(
      `INSERT INTO preview_credit_purchases(preview_account_id, source_row_key, amount, currency, direction,
         posting_status, billing_status, consumed_at, consumed_at_precision, posting_date, source_card_key,
         statement_key, bank_reference, description, first_collected_at, last_collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       ON CONFLICT(preview_account_id, source_row_key) DO UPDATE SET
         amount=EXCLUDED.amount, currency=EXCLUDED.currency, direction=EXCLUDED.direction,
         posting_status=EXCLUDED.posting_status, billing_status=EXCLUDED.billing_status,
         consumed_at=EXCLUDED.consumed_at, consumed_at_precision=EXCLUDED.consumed_at_precision,
         posting_date=EXCLUDED.posting_date, source_card_key=EXCLUDED.source_card_key,
         statement_key=EXCLUDED.statement_key, bank_reference=EXCLUDED.bank_reference,
         description=EXCLUDED.description, last_collected_at=EXCLUDED.last_collected_at`,
      [id, purchase.sourceRowKey, purchase.amount, purchase.currency, purchase.direction, purchase.posting.status,
        posted?.billing ?? null, purchase.consumedAt.value, purchase.consumedAt.precision, posted?.postingDate ?? null,
        purchase.sourceCardKey, purchase.statementKey, purchase.bankReference, purchase.description, collectedAt],
    );
  }
  for (const statement of account.statements) await transaction.query(
    `INSERT INTO preview_credit_statements(preview_account_id, statement_key, cycle_start, cycle_end, closing_date,
       due_date, amount, currency, minimum_payment, billing_period, paid_amount, paid, no_payment_needed, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT(preview_account_id, statement_key) DO UPDATE SET
       cycle_start=EXCLUDED.cycle_start, cycle_end=EXCLUDED.cycle_end, closing_date=EXCLUDED.closing_date,
       due_date=EXCLUDED.due_date, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       minimum_payment=COALESCE(EXCLUDED.minimum_payment, preview_credit_statements.minimum_payment),
       billing_period=EXCLUDED.billing_period,
       paid_amount=COALESCE(EXCLUDED.paid_amount, preview_credit_statements.paid_amount),
       paid=COALESCE(EXCLUDED.paid, preview_credit_statements.paid),
       no_payment_needed=COALESCE(EXCLUDED.no_payment_needed, preview_credit_statements.no_payment_needed),
       collected_at=EXCLUDED.collected_at`,
    [id, statement.statementKey, statement.cycleStart, statement.cycleEnd, statement.closingDate, statement.dueDate,
      statement.amount, statement.currency, statement.minimumPayment, statement.billingPeriod, statement.paidAmount,
      statement.paid, statement.noPaymentNeeded, collectedAt],
  );

  const rows = (await transaction.query<StoredPurchase>(
    `SELECT source_row_key, amount, currency, direction, posting_status, billing_status, consumed_at,
            source_card_key, bank_reference, first_collected_at, last_collected_at
       FROM preview_credit_purchases WHERE preview_account_id = $1`,
    [id],
  )).rows;
  const established = (await transaction.query<StoredRelation>(
    "SELECT relation_kind, from_row_key, to_row_key FROM preview_credit_relations WHERE preview_account_id = $1",
    [id],
  )).rows;
  const supersessions = supersedeUnbilled(rows, established, collectedAt);
  await insertRelations(transaction, id, "unbilled_to_billed", supersessions, collectedAt);
  const withSupersessions = [
    ...established,
    ...supersessions.map((pair): StoredRelation => ({ relation_kind: "unbilled_to_billed", from_row_key: pair.from, to_row_key: pair.to })),
  ];
  await insertRelations(transaction, id, "pending_to_posted", pairAuthorizations(rows, withSupersessions), collectedAt);
}

type CreditAccountRow = {
  preview_account_id: string; source_id: string; institution_key: InstitutionKey; display_label: string;
  currency: string; credit_limit: string | null; last_collected_at: string;
  amount: string | null; balance_currency: string | null; observed_at: string | null;
  observed_at_reported: boolean | null; basis: PreviewCreditBasisKind | null; basis_operands: string | null;
};

type CardRow = { preview_account_id: string; source_card_key: string; card_mask: string; display_label: string | null };

function storedBasis(kind: PreviewCreditBasisKind, operands: string): PreviewCreditBasis {
  return { kind, ...JSON.parse(operands) } as PreviewCreditBasis;
}

function storedBalance(row: Pick<CreditAccountRow, "amount" | "balance_currency" | "observed_at" | "observed_at_reported" | "basis" | "basis_operands">): PreviewCreditBalance | null {
  if (row.amount === null || row.basis === null) return null;
  return {
    amount: row.amount,
    currency: row.balance_currency!,
    observedAt: observedAt(row.observed_at!, row.observed_at_reported === true),
    basis: storedBasis(row.basis, row.basis_operands!),
  };
}

const CREDIT_VISIBLE = visiblePredicate("account.source_id", "'credit_card'", 1, 2);

export async function readPreviewCreditAccounts(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewCreditAccountView[]> {
  if (visibility.visible.length === 0) return [];
  const params = visibilityParams(visibility);
  const result = await reader.query<CreditAccountRow>(
    `SELECT account.preview_account_id, account.source_id, account.institution_key, account.display_label,
            account.currency, account.credit_limit, account.last_collected_at, latest.amount,
            latest.currency AS balance_currency, latest.observed_at, latest.observed_at_reported,
            latest.basis, latest.basis_operands
       FROM preview_credit_accounts account
       LEFT JOIN LATERAL (
         SELECT amount, currency, observed_at, observed_at_reported, basis, basis_operands
           FROM preview_credit_balance_observations balance
          WHERE balance.preview_account_id = account.preview_account_id
          ORDER BY observed_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE ${CREDIT_VISIBLE}
      ORDER BY account.source_id, account.display_label, account.preview_account_id`,
    params,
  );
  if (result.rows.length === 0) return [];
  const cards = await reader.query<CardRow>(
    `SELECT preview_account_id, source_card_key, card_mask, display_label FROM preview_credit_cards
      WHERE preview_account_id = ANY($1::text[]) ORDER BY preview_account_id, source_card_key`,
    [result.rows.map((row) => row.preview_account_id)],
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    sourceId: row.source_id,
    institution: row.institution_key,
    product: "credit_card" as const,
    displayLabel: row.display_label,
    currency: row.currency,
    creditLimit: row.credit_limit,
    cards: cards.rows.filter((card) => card.preview_account_id === row.preview_account_id).map((card) => ({
      sourceCardKey: card.source_card_key,
      cardMask: card.card_mask,
      displayLabel: card.display_label,
    })),
    lastCollectedAt: row.last_collected_at,
    latestBalance: storedBalance(row),
  }));
}

type PurchaseRow = {
  preview_account_id: string; source_row_key: string; amount: string; currency: string; direction: PreviewDirection;
  posting_status: "pending" | "posted"; billing_status: "billed" | "unbilled" | null; consumed_at: string;
  consumed_at_precision: PreviewLocalDate["precision"]; posting_date: string | null; source_card_key: string | null;
  statement_key: string | null; bank_reference: string | null; description: string | null;
  authorized_at: string | null; authorized_at_precision: PreviewLocalDate["precision"] | null;
};

/**
 * Visible purchases: a paired authorization and a superseded unbilled purchase
 * are hidden behind the row that replaced them, which carries the
 * authorization time, also when the pairing reached it through a superseded
 * unbilled row.
 */
export async function readPreviewPurchases(
  reader: PreviewReader,
  visibility: PreviewVisibility,
  previewAccountId: string,
): Promise<readonly PreviewPurchaseView[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<PurchaseRow>(
    `SELECT row.preview_account_id, row.source_row_key, row.amount, row.currency, row.direction, row.posting_status,
            row.billing_status, row.consumed_at, row.consumed_at_precision, row.posting_date, row.source_card_key,
            row.statement_key, row.bank_reference, row.description,
            paired.consumed_at AS authorized_at, paired.consumed_at_precision AS authorized_at_precision
       FROM preview_credit_purchases row
       JOIN preview_credit_accounts account ON account.preview_account_id = row.preview_account_id
       LEFT JOIN LATERAL (
         SELECT pending.consumed_at, pending.consumed_at_precision
           FROM preview_credit_relations pairing
           JOIN preview_credit_purchases pending
             ON pending.preview_account_id = pairing.preview_account_id AND pending.source_row_key = pairing.from_row_key
           LEFT JOIN preview_credit_relations supersession
             ON supersession.preview_account_id = pairing.preview_account_id
            AND supersession.relation_kind = 'unbilled_to_billed' AND supersession.from_row_key = pairing.to_row_key
          WHERE pairing.preview_account_id = row.preview_account_id AND pairing.relation_kind = 'pending_to_posted'
            AND (pairing.to_row_key = row.source_row_key OR supersession.to_row_key = row.source_row_key)
          LIMIT 1
       ) paired ON TRUE
      WHERE ${CREDIT_VISIBLE} AND row.preview_account_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM preview_credit_relations hidden
           WHERE hidden.preview_account_id = row.preview_account_id AND hidden.from_row_key = row.source_row_key)
      ORDER BY row.consumed_at DESC, row.source_row_key`,
    [...visibilityParams(visibility), previewAccountId],
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    sourceRowKey: row.source_row_key,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction,
    posting: row.posting_status === "pending"
      ? { status: "pending" }
      : { status: "posted", billing: row.billing_status!, postingDate: row.posting_date },
    consumedAt: { precision: row.consumed_at_precision, value: row.consumed_at },
    sourceCardKey: row.source_card_key,
    statementKey: row.statement_key,
    bankReference: row.bank_reference,
    description: row.description,
    authorizedAt: row.authorized_at === null ? null : { precision: row.authorized_at_precision!, value: row.authorized_at },
  }));
}

type StatementRow = {
  preview_account_id: string; statement_key: string; cycle_start: string | null; cycle_end: string | null; closing_date: string | null;
  due_date: string; amount: string; currency: string; minimum_payment: string | null; billing_period: string;
  paid_amount: string | null; paid: boolean | null; no_payment_needed: boolean | null;
};

export async function readPreviewStatements(
  reader: PreviewReader,
  visibility: PreviewVisibility,
  previewAccountId: string,
): Promise<readonly PreviewStatementView[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<StatementRow>(
    `SELECT statement.preview_account_id, statement.statement_key, statement.cycle_start, statement.cycle_end,
            statement.closing_date, statement.due_date, statement.amount, statement.currency, statement.minimum_payment,
            statement.billing_period, statement.paid_amount, statement.paid, statement.no_payment_needed
       FROM preview_credit_statements statement
       JOIN preview_credit_accounts account ON account.preview_account_id = statement.preview_account_id
      WHERE ${CREDIT_VISIBLE} AND statement.preview_account_id = $3
      ORDER BY statement.billing_period DESC, statement.closing_date DESC, statement.statement_key`,
    [...visibilityParams(visibility), previewAccountId],
  );
  return result.rows.map((row) => ({
    previewAccountId: row.preview_account_id,
    statementKey: row.statement_key,
    cycleStart: row.cycle_start,
    cycleEnd: row.cycle_end,
    closingDate: row.closing_date,
    dueDate: row.due_date,
    amount: row.amount,
    currency: row.currency,
    minimumPayment: row.minimum_payment,
    billingPeriod: row.billing_period,
    paidAmount: row.paid_amount,
    paid: row.paid,
    noPaymentNeeded: row.no_payment_needed,
  }));
}

type CreditHistoryRow = {
  preview_account_id: string; display_label: string; amount: string; currency: string; observed_at: string;
  observed_at_reported: boolean; basis: PreviewCreditBasisKind; basis_operands: string;
};

export async function readPreviewCreditBalanceHistory(
  reader: PreviewReader,
  visibility: PreviewVisibility,
): Promise<readonly PreviewCreditBalanceHistory[]> {
  if (visibility.visible.length === 0) return [];
  const result = await reader.query<CreditHistoryRow>(
    `SELECT account.preview_account_id, account.display_label, balance.amount, balance.currency, balance.observed_at,
            balance.observed_at_reported, balance.basis, balance.basis_operands
       FROM preview_credit_accounts account
       JOIN preview_credit_balance_observations balance ON balance.preview_account_id = account.preview_account_id
      WHERE ${CREDIT_VISIBLE}
      ORDER BY account.preview_account_id, balance.observed_at`,
    visibilityParams(visibility),
  );
  const byAccount = new Map<string, { previewAccountId: string; displayLabel: string; observations: PreviewCreditBalance[] }>();
  for (const row of result.rows) {
    const entry = byAccount.get(row.preview_account_id)
      ?? { previewAccountId: row.preview_account_id, displayLabel: row.display_label, observations: [] };
    entry.observations.push({
      amount: row.amount,
      currency: row.currency,
      observedAt: observedAt(row.observed_at, row.observed_at_reported),
      basis: storedBasis(row.basis, row.basis_operands),
    });
    byAccount.set(row.preview_account_id, entry);
  }
  return [...byAccount.values()];
}
