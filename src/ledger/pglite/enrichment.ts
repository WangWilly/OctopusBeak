import {
  ACCOUNT_EVENT_KIND_ENRICHMENT_CONTRACT_VERSION,
  ACCOUNT_EVENT_KIND_ENRICHMENT_PRODUCER_ID,
  ACCOUNT_EVENT_KIND_ENRICHMENT_PRODUCER_VERSION,
  ACCOUNT_EVENT_KIND_ENRICHMENT_ROUTE_SCOPES,
  ACCOUNT_EVENT_KINDS,
  type AccountEventEvidenceKind,
  BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
  BANK_TRANSACTION_KIND_ENRICHMENT_ROUTE_SCOPES,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_ID,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_VERSION,
  KIND_CATEGORY_ENRICHMENT_CONTRACT_VERSION,
  KIND_CATEGORY_ENRICHMENT_EVIDENCE_KIND,
  KIND_CATEGORY_ENRICHMENT_PRODUCER_ID,
  KIND_CATEGORY_ENRICHMENT_PRODUCER_VERSION,
  KIND_CATEGORY_ENRICHMENT_ROUTE_ID,
  KIND_DERIVED_CATEGORIES,
} from "../canonical/transaction-taxonomy.ts";
import { classifyBankTransactionKind, classifyCreditCardInflowKind, classifyCreditCardOutflowKind } from "../canonical/transaction-kind-classifier.ts";
import { classifyCathayDescription } from "../canonical/cathay-description-classifier.ts";

export type PGliteProjectionTransaction = Readonly<{
  transactionId: string;
  sourceRecordId: string;
  direction: "inflow" | "outflow";
  amountCoefficient: string;
  amountScale: number;
  currency: string;
  effectiveOn: string;
  description: string | null;
  sourcePayload: string | null;
  integrationNamespace: string;
  stream: string;
  /** The Institution that maintains the account; an Intermediary source's account names the bank, not the source. */
  institutionKey: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  /** The investment action or loan event kind its source recorded, when it recorded one. */
  accountEvent?: PGliteAccountEvent | null;
}>;

export type PGliteAccountEvent =
  | Readonly<{ evidenceKind: "investment-event"; value: keyof (typeof ACCOUNT_EVENT_KINDS)["investment-event"] }>
  | Readonly<{ evidenceKind: "loan-event"; value: keyof (typeof ACCOUNT_EVENT_KINDS)["loan-event"] }>;

export type PGliteProjectionRelations = Readonly<{
  investmentFundingDirection?: "inflow" | "outflow";
  activeLoanRepayment?: boolean;
  creditCardStatementRevisionId?: string;
}>;

export type PGliteDerivedKind = Readonly<{
  value: string;
  outputState?: "supported" | "unsupported";
  evidenceKind:
    | "bank-rule"
    | "investment-relation"
    | "loan-relation"
    | "credit-card-statement-relation"
    | "direction"
    | AccountEventEvidenceKind;
  sourceField: string;
  sourceValue: string;
  contractVersion: string;
  producerId: string;
  producerVersion: string;
  ruleLineage: string;
  routeId: string;
}>;

const BANK_ROUTE_SCOPES: ReadonlySet<string> = new Set(BANK_TRANSACTION_KIND_ENRICHMENT_ROUTE_SCOPES);

function bankRoute(transaction: PGliteProjectionTransaction): {
  producerId: string;
  producerVersion: string;
  contractVersion: string;
  ruleLineage: string;
  routeId: string;
} | null {
  const scope = `${transaction.integrationNamespace}/${transaction.stream}`;
  if (scope === "cathay/domestic-deposit") {
    return {
      producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      contractVersion: "cathay/domestic-deposit/v1",
      ruleLineage: `${BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION}/cathay-classification`,
      routeId: "cathay/domestic-deposit/automatic-enrichment/v1/kind",
    };
  }
  if (!BANK_ROUTE_SCOPES.has(scope)) return null;
  return {
    producerId: BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
    producerVersion: BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
    contractVersion: BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION,
    ruleLineage: `${BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION}/classification`,
    routeId: `${scope}/kind-enrichment/v4/kind`,
  };
}

function creditCardRoute(transaction: PGliteProjectionTransaction): {
  producerId: string;
  producerVersion: string;
  contractVersion: string;
  ruleLineage: string;
  routeId: string;
} | null {
  if (transaction.stream !== "credit-card") return null;
  const supported = new Set(["yuanta", "esun", "fubon"]);
  if (!supported.has(transaction.integrationNamespace)) return null;
  return {
    producerId: CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_ID,
    producerVersion: CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_VERSION,
    contractVersion: CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION,
    ruleLineage: `${CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION}/direction-fallback`,
    routeId: `${transaction.integrationNamespace}/credit-card/direction-enrichment/v1/kind`,
  };
}

const ACCOUNT_EVENT_SCOPES: ReadonlyMap<string, AccountEventEvidenceKind> = new Map(
  (Object.entries(ACCOUNT_EVENT_KIND_ENRICHMENT_ROUTE_SCOPES) as [AccountEventEvidenceKind, readonly string[]][])
    .flatMap(([evidenceKind, scopes]) => scopes.map((scope) => [scope, evidenceKind] as const)),
);

const ACCOUNT_EVENT_SOURCE_FIELDS: Readonly<Record<AccountEventEvidenceKind, string>> = {
  "investment-event": "investment_transactions.action",
  "loan-event": "loan_transaction_facts.event_kind",
};

/**
 * An investment or loan row's Kind, read from the event its source recorded
 * (ADR 0138). A row on such a stream without that event gets no Kind.
 */
function accountEventKind(transaction: PGliteProjectionTransaction): PGliteDerivedKind | null | undefined {
  const scope = `${transaction.integrationNamespace}/${transaction.stream}`;
  const evidenceKind = ACCOUNT_EVENT_SCOPES.get(scope);
  if (evidenceKind === undefined) return undefined;
  const event = transaction.accountEvent;
  if (!event || event.evidenceKind !== evidenceKind) return null;
  const kinds: Readonly<Record<string, string>> = ACCOUNT_EVENT_KINDS[evidenceKind];
  const value = kinds[event.value];
  if (value === undefined) return null;
  return {
    value,
    evidenceKind,
    sourceField: ACCOUNT_EVENT_SOURCE_FIELDS[evidenceKind],
    sourceValue: event.value,
    contractVersion: ACCOUNT_EVENT_KIND_ENRICHMENT_CONTRACT_VERSION,
    producerId: ACCOUNT_EVENT_KIND_ENRICHMENT_PRODUCER_ID,
    producerVersion: ACCOUNT_EVENT_KIND_ENRICHMENT_PRODUCER_VERSION,
    ruleLineage: `${ACCOUNT_EVENT_KIND_ENRICHMENT_CONTRACT_VERSION}/${evidenceKind}`,
    routeId: `${scope}/event-kind-enrichment/v1/kind`,
  };
}

function bankClassification(
  transaction: PGliteProjectionTransaction,
  relations: PGliteProjectionRelations,
): { value: string; evidenceKind: PGliteDerivedKind["evidenceKind"]; sourceField: string; sourceValue: string } {
  if (relations.investmentFundingDirection) {
    return {
      value: relations.investmentFundingDirection === "outflow" ? "transfer.investment_contribution" : "transfer.investment_withdrawal",
      evidenceKind: "investment-relation",
      sourceField: "source_kind",
      sourceValue: relations.investmentFundingDirection,
    };
  }
  if (relations.activeLoanRepayment && transaction.direction === "outflow") {
    return { value: "payment.loan", evidenceKind: "loan-relation", sourceField: "source_kind", sourceValue: "active-loan-repayment-relation" };
  }
  if (relations.creditCardStatementRevisionId) {
    return { value: "payment.credit_card", evidenceKind: "credit-card-statement-relation", sourceField: "canonical_credit_card_statement_revision", sourceValue: relations.creditCardStatementRevisionId };
  }
  const classified = classifyBankTransactionKind({
    direction: transaction.direction,
    description: transaction.description,
    sourcePayload: transaction.sourcePayload,
    institutionKey: transaction.institutionKey,
    stream: transaction.stream,
  });
  return { ...classified, sourceValue: transaction.description ?? transaction.sourcePayload ?? "" };
}

/**
 * Pure PGlite-side classification.  It mirrors the canonical bank rule
 * contract while keeping the worker free of the SQLite projection runtime.
 */
export function derivePGliteTransactionKind(
  transaction: PGliteProjectionTransaction,
  relations: PGliteProjectionRelations = {},
): PGliteDerivedKind | null {
  if (
    transaction.integrationNamespace === "cathay" &&
    transaction.stream === "domestic-deposit"
  ) return derivePGliteCathayDescriptionKind(transaction);
  const event = accountEventKind(transaction);
  if (event !== undefined) return event;
  const card = creditCardRoute(transaction);
  if (card) {
    const described = transaction.direction === "inflow"
      ? classifyCreditCardInflowKind(transaction.description)
      : classifyCreditCardOutflowKind(transaction.description);
    if (described)
      return {
        ...described,
        sourceValue: transaction.description ?? "",
        ...card,
        ruleLineage: `${card.contractVersion}/${transaction.direction}-description`,
      };
    return {
      value: transaction.direction === "outflow" ? "purchase" : "refund",
      evidenceKind: "direction",
      sourceField: "direction",
      sourceValue: transaction.direction,
      ...card,
    };
  }
  const route = bankRoute(transaction);
  if (!route) return null;
  const classification = bankClassification(transaction, relations);
  return { ...classification, ...route };
}

/**
 * Cathay's description producer has a conservative unsupported state.  Keep
 * that state explicit so a source row with an unrecognised description does
 * not silently become a generic purchase/receipt in the worker projection.
 */
function derivePGliteCathayDescriptionKind(
  transaction: PGliteProjectionTransaction,
): PGliteDerivedKind | null {
  if (
    transaction.integrationNamespace !== "cathay" ||
    transaction.stream !== "domestic-deposit"
  ) return null;
  const classification = classifyCathayDescription(transaction.description, transaction.direction);
  const candidate = classification.candidates[0];
  return {
    value: candidate?.value ?? "",
    outputState: candidate ? "supported" : "unsupported",
    evidenceKind: "bank-rule",
    sourceField: "description",
    sourceValue: transaction.description ?? "",
    contractVersion: "cathay/domestic-deposit/v1",
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    ruleLineage: "cathay/domestic-deposit/v1/description-taxonomy",
    routeId: "cathay/domestic-deposit/automatic-enrichment/v1/kind",
  };
}

export type PGliteDerivedCategory = Readonly<{
  value: string;
  evidenceKind: typeof KIND_CATEGORY_ENRICHMENT_EVIDENCE_KIND;
  sourceField: "kind";
  /** The Kind code the category was read from. */
  sourceValue: string;
  contractVersion: string;
  producerId: string;
  producerVersion: string;
  ruleLineage: string;
  routeId: string;
}>;

const KIND_CATEGORIES: ReadonlyMap<string, string> = new Map(Object.entries(KIND_DERIVED_CATEGORIES));

/**
 * The Personal Category a transaction's current Kind alone decides (ADR 0141),
 * or null when the Kind decides none. It reads nothing else about the row.
 */
export function derivePGliteKindCategory(kind: string | null): PGliteDerivedCategory | null {
  const value = kind === null ? undefined : KIND_CATEGORIES.get(kind);
  if (value === undefined || kind === null) return null;
  return {
    value,
    evidenceKind: KIND_CATEGORY_ENRICHMENT_EVIDENCE_KIND,
    sourceField: "kind",
    sourceValue: kind,
    contractVersion: KIND_CATEGORY_ENRICHMENT_CONTRACT_VERSION,
    producerId: KIND_CATEGORY_ENRICHMENT_PRODUCER_ID,
    producerVersion: KIND_CATEGORY_ENRICHMENT_PRODUCER_VERSION,
    ruleLineage: `${KIND_CATEGORY_ENRICHMENT_CONTRACT_VERSION}/${value}`,
    routeId: KIND_CATEGORY_ENRICHMENT_ROUTE_ID,
  };
}
