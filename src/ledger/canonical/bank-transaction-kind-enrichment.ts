import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION,
  BANK_TRANSACTION_KIND_ENRICHMENT_EVIDENCE_KINDS,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
} from "./transaction-taxonomy.ts";
import { blob, idToString } from "./canonical-schema-implementation.ts";
import {
  commitCanonicalAutomaticEnrichmentRunInTransaction,
  type CanonicalEnrichmentCommitResult,
  type CanonicalEnrichmentOutput,
  type CanonicalEnrichmentRunInput,
} from "./canonical-enrichment.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";

const FOREIGN_CURRENCY_DEPOSIT_STREAM = "foreign-currency-deposit" as const;
const CATHAY_DOMESTIC_SCOPE = "cathay/domestic-deposit" as const;

export const BANK_TRANSACTION_KIND_RULE_LINEAGE =
  `${BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION}/classification` as const;

export const BANK_TRANSACTION_KIND_SUPPORTED_SCOPES = [
  CATHAY_DOMESTIC_SCOPE,
  "cathay/foreign-currency-deposit",
  "yuanta/domestic-deposit",
  "yuanta/foreign-currency-deposit",
  "hncb/domestic-deposit",
  "sinopac/domestic-deposit",
  "sinopac/foreign-currency-deposit",
  "linebank/domestic-deposit",
  "fubon/domestic-deposit",
  "post/domestic-deposit",
  "ctbc/domestic-deposit",
] as const;

export type BankTransactionKindScopeKey =
  (typeof BANK_TRANSACTION_KIND_SUPPORTED_SCOPES)[number];

export type BankTransactionKindEnrichmentOptions = Readonly<{
  observedAt?: string;
  ruleLineage?: string;
  /**
   * Relation resolution must re-evaluate a row when the active loan endpoint
   * set changes, even while the producer version remains the same. The
   * resulting lineage is scoped to that active relation state.
   */
  relationStateAware?: boolean;
}>;

type CurrentTransaction = Readonly<{
  transactionId: string;
  sourceRecordId: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  integrationNamespace: string;
  stream: string;
  direction: "inflow" | "outflow";
  amountCoefficient: string;
  amountScale: number;
  currency: string;
  effectiveOn: string;
  description: string | null;
  sourcePayload: string | null;
  observedAt: string;
}>;

type CurrentKind = Readonly<{ origin: string; value: string }>;

type Scope = Readonly<{
  scopeKey: BankTransactionKindScopeKey;
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
}>;

type TransactionClassification = Readonly<{
  value: string;
  evidenceKind: (typeof BANK_TRANSACTION_KIND_ENRICHMENT_EVIDENCE_KINDS)[number];
  sourceField: string;
  sourceValue: string;
}>;

type CreditCardStatementMatch = Readonly<{
  statementId: string;
  statementRevisionId: string;
}>;

export type CreditCardStatementMatchFact = CreditCardStatementMatch & Readonly<{
  issueDate: string;
  dueDate: string;
  currency: string;
  balanceCoefficient: string;
  balanceScale: number;
}>;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function idKey(value: unknown, label: string): string {
  try {
    return idToString(blob(value));
  } catch {
    throw new Error(`${label} is not a canonical ID.`);
  }
}

function textIdKey(value: string, label: string): string {
  const normalized = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(normalized))
    throw new Error(`${label} is not a canonical ID.`);
  return idKey(Buffer.from(normalized, "hex"), label);
}

function scopeKey(
  integrationNamespace: string,
  stream: string,
): BankTransactionKindScopeKey | null {
  const key = `${integrationNamespace}/${stream}`;
  return (BANK_TRANSACTION_KIND_SUPPORTED_SCOPES as readonly string[]).includes(key)
    ? (key as BankTransactionKindScopeKey)
    : null;
}

function capturePredicate(captureIds: readonly string[]): {
  sql: string;
  parameters: string[];
} {
  if (captureIds.length === 0) return { sql: "0", parameters: [] };
  const keys = captureIds.map((value) => value.trim()).filter(Boolean);
  const hexKeys = keys.map((value) => value.replaceAll("-", "").toLowerCase());
  const placeholders = keys.map(() => "?").join(",");
  const hexPlaceholders = hexKeys.map(() => "?").join(",");
  return {
    sql: `(capture.capture_key IN (${placeholders}) OR lower(hex(capture.capture_id)) IN (${hexPlaceholders}))`,
    parameters: [...keys, ...hexKeys],
  };
}

function readScopes(
  db: DatabaseSync,
  captureIds: readonly string[],
): Scope[] {
  const predicate = capturePredicate(captureIds);
  const rows = db.prepare(`
    SELECT DISTINCT connection.integration_namespace,
                    connection.source_connection_key,
                    epoch.epoch_key AS identity_epoch,
                    capture.stream
      FROM source_captures capture
      JOIN source_connections connection
        ON connection.source_connection_id = capture.source_connection_id
      JOIN identity_epochs epoch
        ON epoch.identity_epoch_id = capture.identity_epoch_id
     WHERE ${predicate.sql}
     ORDER BY connection.integration_namespace, capture.stream,
              connection.source_connection_key, epoch.epoch_key
  `).all(...predicate.parameters) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const integrationNamespace = requiredText(
      row.integration_namespace,
      "Bank integration namespace",
    );
    const stream = requiredText(row.stream, "Bank transaction stream");
    const key = scopeKey(integrationNamespace, stream);
    if (!key) return [];
    return [{
      scopeKey: key,
      integrationNamespace,
      sourceConnectionKey: requiredText(
        row.source_connection_key,
        "Bank source connection key",
      ),
      identityEpoch: requiredText(row.identity_epoch, "Bank identity epoch"),
      stream,
    }];
  });
}

function readCurrentTransactions(
  db: DatabaseSync,
  captureIds: readonly string[],
): CurrentTransaction[] {
  if (captureIds.length === 0) return [];
  const scopes = readScopes(db, captureIds);
  const projectionRuntime = createCanonicalProjectionRuntime(db);
  const predicate = capturePredicate(captureIds);
  const transactions: CurrentTransaction[] = [];
  const seen = new Set<string>();

  for (const scope of scopes) {
    const projection = projectionRuntime.read({
      kind: "current",
      families: ["financial-accounts", "transactions"],
      scope: { sourceConnectionKey: scope.sourceConnectionKey },
    });
    const accountIds = new Set(
      projection.families["financial-accounts"]
        .filter(
          (account) =>
            account.integrationNamespace === scope.integrationNamespace &&
            account.sourceConnectionKey === scope.sourceConnectionKey &&
            account.stream === scope.stream,
        )
        .map((account) => account.accountId),
    );
    const projectedTransactions = projection.families.transactions.filter(
      (transaction) => accountIds.has(transaction.accountId),
    );
    if (projectedTransactions.length === 0) continue;

    const revisionPlaceholders = projectedTransactions.map(() => "?").join(",");
    const revisionIds = projectedTransactions.map((transaction) =>
      Buffer.from(transaction.revisionId.replaceAll("-", ""), "hex"),
    );
    const rows = db.prepare(`
      SELECT revision.transaction_id,
             revision.revision_id,
             revision.source_record_id,
             connection.source_connection_key,
             epoch.epoch_key AS identity_epoch,
             connection.integration_namespace,
             account.stream,
             COALESCE(source_record.description, revision.description) AS description,
             source_record.payload_json AS source_payload,
             capture.observed_at
        FROM transaction_revisions revision
        JOIN financial_transactions transaction_row
          ON transaction_row.transaction_id = revision.transaction_id
        JOIN source_records source_record
          ON source_record.source_record_id = revision.source_record_id
         AND source_record.capture_id = revision.capture_id
        JOIN source_record_scopes record_scope
          ON record_scope.source_record_id = source_record.source_record_id
         AND record_scope.capture_id = source_record.capture_id
         AND record_scope.account_id = transaction_row.account_id
        JOIN source_captures capture
          ON capture.capture_id = record_scope.capture_id
        JOIN financial_accounts account
          ON account.account_id = record_scope.account_id
        JOIN source_connections connection
          ON connection.source_connection_id = account.source_connection_id
        JOIN identity_epochs epoch
          ON epoch.identity_epoch_id = account.identity_epoch_id
       WHERE revision.revision_id IN (${revisionPlaceholders})
         AND ${predicate.sql}
       ORDER BY capture.observed_at DESC, revision.rowid DESC
    `).all(...revisionIds, ...predicate.parameters) as Array<Record<string, unknown>>;
    const sourceFacts = new Map(
      rows.map((row) => [
        `${idKey(row.transaction_id, "Bank transaction ID")}:${idKey(row.revision_id, "Bank revision ID")}`,
        row,
      ]),
    );

    for (const projected of projectedTransactions) {
      const transactionKey = `${textIdKey(projected.transactionId, "Bank transaction ID")}:${textIdKey(projected.revisionId, "Bank revision ID")}`;
      if (seen.has(transactionKey)) continue;
      const row = sourceFacts.get(transactionKey);
      if (!row) continue;
      if (
        requiredText(row.integration_namespace, "Bank integration namespace") !==
          scope.integrationNamespace ||
        requiredText(row.source_connection_key, "Bank source connection key") !==
          scope.sourceConnectionKey ||
        requiredText(row.identity_epoch, "Bank identity epoch") !== scope.identityEpoch ||
        requiredText(row.stream, "Bank transaction stream") !== scope.stream
      )
        continue;
      const direction = requiredText(projected.direction, "Bank transaction direction");
      if (direction !== "inflow" && direction !== "outflow")
        throw new Error(`Bank transaction direction ${direction} is unsupported.`);
      seen.add(transactionKey);
      transactions.push({
        transactionId: textIdKey(projected.transactionId, "Bank transaction ID"),
        sourceRecordId: idKey(row.source_record_id, "Bank source record ID"),
        sourceConnectionKey: scope.sourceConnectionKey,
        identityEpoch: scope.identityEpoch,
        integrationNamespace: scope.integrationNamespace,
        stream: scope.stream,
        direction: direction as "inflow" | "outflow",
        amountCoefficient: requiredText(
          projected.amountCoefficient,
          "Bank transaction amount coefficient",
        ),
        amountScale: projected.amountScale,
        currency: requiredText(projected.currency, "Bank transaction currency"),
        effectiveOn: requiredText(
          projected.effectiveOn,
          "Bank transaction effective date",
        ),
        description:
          row.description === null || row.description === undefined
            ? projected.description
            : String(row.description),
        sourcePayload:
          row.source_payload === null || row.source_payload === undefined
            ? null
            : String(row.source_payload),
        observedAt: requiredText(row.observed_at, "Bank capture observed-at"),
      });
    }
  }

  return transactions.sort((left, right) =>
    `${left.integrationNamespace}/${left.stream}/${left.sourceConnectionKey}/${left.transactionId}`
      .localeCompare(
        `${right.integrationNamespace}/${right.stream}/${right.sourceConnectionKey}/${right.transactionId}`,
      ),
  );
}

function readCurrentKinds(
  db: DatabaseSync,
  transactions: readonly CurrentTransaction[],
): ReadonlyMap<string, CurrentKind> {
  if (transactions.length === 0) return new Map();
  const rows = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transaction-enrichment"],
    scope: { transactionIds: transactions.map((transaction) => transaction.transactionId) },
  }).families["transaction-enrichment"];
  return new Map(
    rows
      .filter((row) => row.fieldName === "kind")
      .map((row) => [
      textIdKey(row.transactionId, "Enriched transaction ID"),
      {
        origin: requiredText(row.origin, "Current Kind origin"),
        value: requiredText(row.taxonomyCode ?? row.value, "Current Kind value"),
      },
      ]),
  );
}

function readActiveInvestmentFunding(
  db: DatabaseSync,
  transactions: readonly CurrentTransaction[],
): ReadonlyMap<string, "inflow" | "outflow"> {
  if (transactions.length === 0) return new Map();
  const ids = transactions.map((transaction) => Buffer.from(transaction.transactionId.replaceAll("-", ""), "hex"));
  const rows = db.prepare(`
    SELECT relation.funding_transaction_id, relation.direction
      FROM investment_funding_relations relation
     WHERE relation.funding_transaction_id IN (${ids.map(() => "?").join(",")})
       AND COALESCE((
         SELECT event.event_kind
           FROM investment_funding_relation_events event
           JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
          WHERE event.relation_id = relation.relation_id
          ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
          LIMIT 1
       ), 'withdrawn') = 'observed'
  `).all(...ids) as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [
    idKey(row.funding_transaction_id, "Investment funding transaction ID"),
    String(row.direction) as "inflow" | "outflow",
  ]));
}

function readActiveLoanTransactions(
  db: DatabaseSync,
  transactions: readonly CurrentTransaction[],
): ReadonlySet<string> {
  if (transactions.length === 0) return new Set();
  const ids = transactions.map((transaction) => Buffer.from(transaction.transactionId.replaceAll("-", ""), "hex"));
  const rows = db.prepare(`
    SELECT member.transaction_id
      FROM loan_repayment_settlement_group_members member
      JOIN loan_repayment_settlement_groups group_row
        ON group_row.settlement_group_id = member.settlement_group_id
     WHERE member.member_kind = 'deposit_outflow'
       AND member.transaction_id IN (${ids.map(() => "?").join(",")})
       AND COALESCE((
         SELECT event.event_kind
           FROM loan_repayment_relation_events event
           JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
          WHERE event.settlement_group_id = group_row.settlement_group_id
          ORDER BY event_commit.commit_sequence DESC, event.event_id DESC
          LIMIT 1
       ), 'withdrawn') NOT IN ('withdrawn', 'superseded')
    UNION
    SELECT relation.from_transaction_id
      FROM transaction_relations relation
      JOIN loan_repayment_relation_events event
        ON event.relation_id = relation.relation_id
      JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
     WHERE relation.from_transaction_id IN (${ids.map(() => "?").join(",")})
       AND event.event_kind = 'observed'
       AND event_commit.commit_sequence = (
         SELECT MAX(latest_commit.commit_sequence)
           FROM loan_repayment_relation_events latest_event
           JOIN canonical_commits latest_commit ON latest_commit.commit_id = latest_event.commit_id
          WHERE latest_event.relation_id = relation.relation_id
       )
    UNION
    SELECT relation.to_transaction_id
      FROM transaction_relations relation
      JOIN loan_repayment_relation_events event
        ON event.relation_id = relation.relation_id
      JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
     WHERE relation.to_transaction_id IN (${ids.map(() => "?").join(",")})
       AND event.event_kind = 'observed'
       AND event_commit.commit_sequence = (
         SELECT MAX(latest_commit.commit_sequence)
           FROM loan_repayment_relation_events latest_event
           JOIN canonical_commits latest_commit ON latest_commit.commit_id = latest_event.commit_id
          WHERE latest_event.relation_id = relation.relation_id
       )
  `).all(...ids, ...ids, ...ids) as Array<Record<string, unknown>>;
  return new Set(rows.map((row) => idKey(row.transaction_id, "Loan repayment transaction ID")));
}

function textFor(transaction: CurrentTransaction): string {
  return [transaction.description, transaction.sourcePayload]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
}

function exactAmountKey(coefficient: string, scale: number): string {
  if (!/^-?\d+$/u.test(coefficient) || !Number.isSafeInteger(scale) || scale < 0)
    throw new Error("Financial amount is not an exact decimal.");
  let digits = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    normalizedScale -= 1;
  }
  return `${BigInt(digits).toString()}:${normalizedScale}`;
}

export function matchUniqueCreditCardStatementForBankOutflow(
  transaction: Readonly<{
    direction: "inflow" | "outflow";
    amountCoefficient: string;
    amountScale: number;
    currency: string;
    effectiveOn: string;
  }>,
  statements: readonly CreditCardStatementMatchFact[],
): CreditCardStatementMatch | null {
  if (transaction.direction !== "outflow") return null;
  const amountKey = exactAmountKey(
    transaction.amountCoefficient,
    transaction.amountScale,
  );
  const candidates = statements.filter((statement) =>
    statement.currency === transaction.currency &&
    transaction.effectiveOn >= statement.issueDate &&
    transaction.effectiveOn <= statement.dueDate &&
    exactAmountKey(statement.balanceCoefficient, statement.balanceScale) ===
      amountKey
  );
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  return {
    statementId: candidate.statementId,
    statementRevisionId: candidate.statementRevisionId,
  };
}

function readCreditCardStatementMatches(
  db: DatabaseSync,
  transactions: readonly CurrentTransaction[],
): ReadonlyMap<string, CreditCardStatementMatch> {
  const outflows = transactions.filter((row) => row.direction === "outflow");
  if (outflows.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT statement.statement_id,
           revision.statement_revision_id,
           revision.issue_date,
           revision.due_date,
           revision.currency,
           revision.balance_coefficient,
           revision.balance_scale
      FROM canonical_credit_card_statements statement
      JOIN canonical_credit_card_statement_revisions revision
        ON revision.statement_id = statement.statement_id
     WHERE revision.revision_number = (
       SELECT MAX(latest.revision_number)
         FROM canonical_credit_card_statement_revisions latest
        WHERE latest.statement_id = revision.statement_id
     )
  `).all() as Array<Record<string, unknown>>;
  const statements = rows.map((row): CreditCardStatementMatchFact => ({
    statementId: idKey(row.statement_id, "Credit-card statement ID"),
    statementRevisionId: idKey(
      row.statement_revision_id,
      "Credit-card statement revision ID",
    ),
    issueDate: requiredText(row.issue_date, "Credit-card statement issue date"),
    dueDate: requiredText(row.due_date, "Credit-card statement due date"),
    currency: requiredText(row.currency, "Credit-card statement currency"),
    balanceCoefficient: requiredText(
      row.balance_coefficient,
      "Credit-card statement balance coefficient",
    ),
    balanceScale: Number(row.balance_scale),
  }));
  const matches = new Map<string, CreditCardStatementMatch>();
  for (const transaction of outflows) {
    const match = matchUniqueCreditCardStatementForBankOutflow(
      transaction,
      statements,
    );
    if (match) matches.set(transaction.transactionId, match);
  }
  return matches;
}

function explicitSelfTransfer(text: string): boolean {
  return /(自轉|自動轉帳|本人(?:帳戶|轉帳|匯款)|同名(?:轉帳|帳戶)|自有帳戶|轉入本人|轉出本人)/u.test(text);
}

function explicitExternalTransfer(text: string): boolean {
  return /(匯款|電匯|跨行|ach|wire|swift|remittance|轉出至|轉入自)/iu.test(text);
}

function explicitInvestment(text: string): boolean {
  return /(股票|證券|etf|基金|共同基金|信託|複委託|美股|台股|投資|brokerage|security)/iu.test(text);
}

const YUANTA_SCHEDULED_FUND_SUBSCRIPTION_DESCRIPTION =
  /^\s*轉帳支取\s*·\s*\d{16}\s+YT\d{2}\s+FS\d{8}\s+約定申購\s+\d{5}\s+174\s+FISB\s*$/iu;

function isYuantaScheduledFundSubscription(
  transaction: CurrentTransaction,
): boolean {
  return (
    transaction.integrationNamespace === "yuanta" &&
    transaction.stream === "domestic-deposit" &&
    transaction.direction === "outflow" &&
    typeof transaction.description === "string" &&
    YUANTA_SCHEDULED_FUND_SUBSCRIPTION_DESCRIPTION.test(
      transaction.description,
    )
  );
}

function isFubonStructuredCreditCardPayment(
  transaction: CurrentTransaction,
): boolean {
  if (
    transaction.integrationNamespace !== "fubon" ||
    transaction.stream !== "domestic-deposit" ||
    transaction.direction !== "outflow" ||
    typeof transaction.description !== "string"
  )
    return false;
  const compactDescription = transaction.description.replace(/\s+/gu, "");
  return /^(?:行動|網路)?繳費·(?:繳)?[^·]+信用卡(?:款|費)[^·]*$/u.test(
    compactDescription,
  );
}

function isFubonStructuredLoanPayment(
  transaction: CurrentTransaction,
): boolean {
  if (
    transaction.integrationNamespace !== "fubon" ||
    transaction.stream !== "domestic-deposit" ||
    transaction.direction !== "outflow" ||
    typeof transaction.description !== "string"
  )
    return false;
  const sourceAction = transaction.description.split("·", 1)[0]
    ?.replace(/\s+/gu, "") ?? "";
  return sourceAction === "放款繳款";
}

function classify(
  transaction: CurrentTransaction,
  fundingDirection: "inflow" | "outflow" | undefined,
  loanTransactions: ReadonlySet<string>,
  creditCardStatements: ReadonlyMap<string, CreditCardStatementMatch>,
): TransactionClassification {
  const text = textFor(transaction);
  const direction = transaction.direction;
  const sourceValue = transaction.description ?? transaction.sourcePayload ?? "";

  if (fundingDirection) {
    return {
      value: fundingDirection === "outflow"
        ? "transfer.investment_contribution"
        : "transfer.investment_withdrawal",
      evidenceKind: "investment-relation",
      sourceField: "source_kind",
      sourceValue: fundingDirection,
    };
  }
  if (loanTransactions.has(transaction.transactionId) && direction === "outflow")
    return {
      value: "payment.loan",
      evidenceKind: "loan-relation",
      sourceField: "source_kind",
      sourceValue: "active-loan-repayment-relation",
    };

  const creditCardStatement = creditCardStatements.get(transaction.transactionId);
  if (creditCardStatement)
    return {
      value: "payment.credit_card",
      evidenceKind: "credit-card-statement-relation",
      sourceField: "canonical_credit_card_statement_revision",
      sourceValue: creditCardStatement.statementRevisionId,
    };

  if (isYuantaScheduledFundSubscription(transaction))
    return {
      value: "investment.trade.buy",
      evidenceKind: "bank-rule",
      sourceField: "source_description",
      sourceValue,
    };

  if (isFubonStructuredCreditCardPayment(transaction))
    return {
      value: "payment.credit_card",
      evidenceKind: "bank-rule",
      sourceField: "source_description",
      sourceValue,
    };

  if (isFubonStructuredLoanPayment(transaction))
    return {
      value: "payment.loan",
      evidenceKind: "bank-rule",
      sourceField: "source_description",
      sourceValue,
    };

  if (explicitSelfTransfer(text))
    return {
      value: "transfer.internal",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (explicitExternalTransfer(text))
    return {
      value: "transfer.external",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(繳卡|卡費|信用卡繳|credit\s*card\s*(?:payment|bill)|card\s*payment)/iu.test(text))
    return {
      value: "payment.credit_card",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(還款|還本|房貸|信貸|車貸|貸款繳|loan\s*(?:payment|repayment))/iu.test(text))
    return {
      value: "payment.loan",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(提款|提領|atm|自動櫃員機|cash\s*withdrawal)/iu.test(text))
    return {
      value: "cash.withdrawal",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(現金存入|現金存款|現金入帳|cash\s*deposit)/iu.test(text) && direction === "inflow")
    return {
      value: "cash.deposit",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (explicitInvestment(text)) {
    if (/(複委託扣|投資(?:帳戶)?扣|證券(?:戶)?扣)/u.test(text) && direction === "outflow")
      return {
        value: "transfer.investment_contribution",
        evidenceKind: "bank-rule",
        sourceField: "source_kind",
        sourceValue,
      };
    if (/(複委託入|投資(?:帳戶)?入|證券(?:戶)?入)/u.test(text) && direction === "inflow")
      return {
        value: "transfer.investment_withdrawal",
        evidenceKind: "bank-rule",
        sourceField: "source_kind",
        sourceValue,
      };
    if (/(賣出|賣股|sell|贖回)/iu.test(text))
      return {
        value: "investment.trade.sell",
        evidenceKind: "bank-rule",
        sourceField: "source_kind",
        sourceValue,
      };
    if (direction === "outflow" && /(買股|買股票|股票買|申購|買基金|buy)/iu.test(text))
      return {
        value: "investment.trade.buy",
        evidenceKind: "bank-rule",
        sourceField: "source_kind",
        sourceValue,
      };
  }
  if (/(手續費|服務費|管理費|費用|fee|commission)/iu.test(text))
    return {
      value: /投資|證券|股票|基金|複委託|commission/iu.test(text)
        ? "fee.investment"
        : /信用卡|卡片|card/iu.test(text)
          ? "fee.card"
          : "fee.bank",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(利息|interest)/iu.test(text))
    return {
      value: direction === "inflow" ? "interest.earned" : "interest.charged",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(退款|退刷|退回|refund)/iu.test(text))
    return {
      value: "refund",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(沖銷|撤銷|作廢|reversal|void)/iu.test(text))
    return {
      value: "reversal",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(貸款撥款|撥款|loan\s*disbursement)/iu.test(text) && direction === "inflow")
    return {
      value: "loan.disbursement",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(薪資|薪水|工資|salary|payroll)/iu.test(text) && direction === "inflow")
    return {
      value: "income.employment.salary",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(獎金|bonus)/iu.test(text) && direction === "inflow")
    return {
      value: "income.employment.bonus",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(股息|股利|dividend)/iu.test(text) && direction === "inflow")
    return {
      value: "income.dividend",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(租金|rental)/iu.test(text) && direction === "inflow")
    return {
      value: "income.rental",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  if (/(稅|稅款|tax)/iu.test(text))
    return {
      value: direction === "inflow" ? "tax.refund" : "tax.payment",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
      sourceValue,
    };
  return {
    value: direction === "outflow" ? "purchase" : "receipt",
    evidenceKind: "bank-rule",
      sourceField: "source_kind",
    sourceValue,
  };
}

export function classifyBankTransactionKind(input: Readonly<{
  direction: "inflow" | "outflow";
  description?: string | null;
  sourcePayload?: string | null;
  integrationNamespace?: string;
  stream?: string;
}>): Readonly<{ value: string; evidenceKind: "bank-rule"; sourceField: string }> {
  const transaction = {
    transactionId: "",
    sourceRecordId: "",
    sourceConnectionKey: "",
    identityEpoch: "",
    integrationNamespace: input.integrationNamespace ?? "",
    stream: input.stream ?? "",
    direction: input.direction,
    amountCoefficient: "0",
    amountScale: 0,
    currency: "XXX",
    effectiveOn: "1970-01-01",
    description: input.description ?? null,
    sourcePayload: input.sourcePayload ?? null,
    observedAt: "",
  } satisfies CurrentTransaction;
  const result = classify(transaction, undefined, new Set(), new Map());
  return {
    value: result.value,
    evidenceKind: "bank-rule",
    sourceField: result.sourceField,
  };
}

function outputForTransaction(
  transaction: CurrentTransaction,
  currentKind: CurrentKind | undefined,
  fundingDirection: "inflow" | "outflow" | undefined,
  loanTransactions: ReadonlySet<string>,
  creditCardStatements: ReadonlyMap<string, CreditCardStatementMatch>,
): CanonicalEnrichmentOutput {
  const evidence = classify(
    transaction,
    fundingDirection,
    loanTransactions,
    creditCardStatements,
  );
  const evidencePayload = {
    kind: evidence.evidenceKind,
    sourceRecordId: transaction.sourceRecordId,
    sourceField: evidence.sourceField,
    sourceValue: evidence.sourceValue,
    contractVersion: BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION,
  } as const;
  if (currentKind?.origin === "source")
    return {
      transactionId: transaction.transactionId,
      field: "kind",
      origin: "derived",
      state: "unsupported",
      evidence: evidencePayload,
    };
  return {
    transactionId: transaction.transactionId,
    field: "kind",
    origin: "derived",
    value: evidence.value,
    confidenceBasisPoints: 10_000,
    evidence: evidencePayload,
  };
}

function relationStateLineage(
  baseRuleLineage: string,
  loanTransactions: ReadonlySet<string>,
  creditCardStatements: ReadonlyMap<string, CreditCardStatementMatch>,
): string {
  const stateDigest = createHash("sha256")
    .update([
      ...[...loanTransactions].sort().map((id) => `loan:${id}`),
      ...[...creditCardStatements.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, match]) => `card:${id}:${match.statementRevisionId}`),
    ].join("\u0000"))
    .digest("base64url");
  return `${baseRuleLineage}/loan-state/${stateDigest}`;
}

function producerForScope(scopeKey: BankTransactionKindScopeKey): {
  producerId: string;
  producerVersion: string;
  ruleLineage: string;
} {
  if (scopeKey === CATHAY_DOMESTIC_SCOPE)
    return {
      producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      ruleLineage: `${BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION}/cathay-classification`,
    };
  return {
    producerId: BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
    producerVersion: BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
    ruleLineage: BANK_TRANSACTION_KIND_RULE_LINEAGE,
  };
}

function buildEnrichmentInput(
  db: DatabaseSync,
  scope: Scope,
  captureIds: readonly string[],
  options: BankTransactionKindEnrichmentOptions,
): CanonicalEnrichmentRunInput | null {
  const transactions = readCurrentTransactions(db, captureIds).filter(
    (transaction) =>
      transaction.integrationNamespace === scope.integrationNamespace &&
      transaction.sourceConnectionKey === scope.sourceConnectionKey &&
      transaction.identityEpoch === scope.identityEpoch &&
      transaction.stream === scope.stream,
  );
  if (transactions.length === 0) return null;
  const currentKinds = readCurrentKinds(db, transactions);
  const investmentFunding = readActiveInvestmentFunding(db, transactions);
  const loanTransactions = readActiveLoanTransactions(db, transactions);
  const creditCardStatements = readCreditCardStatementMatches(db, transactions);
  const producer = producerForScope(scope.scopeKey);
  const baseRuleLineage =
    options.ruleLineage?.trim() || producer.ruleLineage;
  return {
    sourceConnectionKey: scope.sourceConnectionKey,
    identityEpoch: scope.identityEpoch,
    stream: scope.stream,
    producerId: producer.producerId,
    producerVersion: producer.producerVersion,
    ruleLineage: options.relationStateAware
      ? relationStateLineage(
          baseRuleLineage,
          loanTransactions,
          creditCardStatements,
        )
      : baseRuleLineage,
    observedAt: options.observedAt || transactions[0]!.observedAt,
    declaredSubjects: transactions.map((transaction) => ({
      transactionId: transaction.transactionId,
      fields: ["kind"] as const,
    })),
    outputs: transactions.map((transaction) =>
      outputForTransaction(
        transaction,
        currentKinds.get(transaction.transactionId),
        investmentFunding.get(transaction.transactionId),
        loanTransactions,
        creditCardStatements,
      ),
    ),
  };
}

/**
 * Enrich bank/deposit transactions while the source capture transaction is
 * still open.  The writer calls this after applying the source projection, so
 * a failed rule or taxonomy admission rolls the source capture back too.
 */
export function commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
  db: DatabaseSync,
  captureIds: readonly string[],
  options: BankTransactionKindEnrichmentOptions = {},
): readonly CanonicalEnrichmentCommitResult[] {
  const results: CanonicalEnrichmentCommitResult[] = [];
  for (const scope of readScopes(db, captureIds)) {
    const input = buildEnrichmentInput(db, scope, captureIds, options);
    if (input)
      results.push(commitCanonicalAutomaticEnrichmentRunInTransaction(db, input));
  }
  return results;
}

export function refreshCanonicalBankTransactionKindsAfterCreditCardCapture(
  db: DatabaseSync,
): readonly CanonicalEnrichmentCommitResult[] {
  const rows = db.prepare(`
    SELECT DISTINCT capture.capture_key
      FROM current_transactions current_row
      JOIN transaction_revisions revision
        ON revision.revision_id = current_row.revision_id
      JOIN financial_transactions transaction_row
        ON transaction_row.transaction_id = current_row.transaction_id
      JOIN financial_accounts account
        ON account.account_id = transaction_row.account_id
      JOIN source_captures capture
        ON capture.capture_id = revision.capture_id
     WHERE account.stream IN ('domestic-deposit', 'foreign-currency-deposit')
       AND capture.capture_key IS NOT NULL
       AND TRIM(capture.capture_key) <> ''
  `).all() as Array<Record<string, unknown>>;
  return commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
    db,
    rows.map((row) => requiredText(row.capture_key, "Bank capture key")),
    { relationStateAware: true },
  );
}
