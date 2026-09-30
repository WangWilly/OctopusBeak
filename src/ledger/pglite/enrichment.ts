import {
  BANK_TRANSACTION_KIND_ENRICHMENT_CONTRACT_VERSION,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_ID,
  BANK_TRANSACTION_KIND_ENRICHMENT_PRODUCER_VERSION,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_CONTRACT_VERSION,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_ID,
  CREDIT_CARD_DIRECTION_ENRICHMENT_PRODUCER_VERSION,
} from "../canonical/transaction-taxonomy.ts";
import { classifyBankTransactionKind } from "../canonical/transaction-kind-classifier.ts";
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
  sourceConnectionKey: string;
  identityEpoch: string;
}>;

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
    | "direction";
  sourceField: string;
  sourceValue: string;
  contractVersion: string;
  producerId: string;
  producerVersion: string;
  ruleLineage: string;
  routeId: string;
}>;

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
  const supported = new Set([
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
  ]);
  if (!supported.has(scope)) return null;
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
    integrationNamespace: transaction.integrationNamespace,
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
  const card = creditCardRoute(transaction);
  if (card) {
    return {
      value: transaction.direction === "outflow" ? "purchase" : "refund",
      evidenceKind: "direction",
      sourceField: "direction",
      sourceValue: transaction.direction,
      contractVersion: card.contractVersion,
      producerId: card.producerId,
      producerVersion: card.producerVersion,
      ruleLineage: card.ruleLineage,
      routeId: card.routeId,
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
export function derivePGliteCathayDescriptionKind(
  transaction: PGliteProjectionTransaction,
): PGliteDerivedKind | null {
  if (
    transaction.integrationNamespace !== "cathay" ||
    transaction.stream !== "domestic-deposit"
  ) return null;
  const classification = classifyCathayDescription(transaction.description);
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
