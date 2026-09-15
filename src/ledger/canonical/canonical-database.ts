import { join } from "node:path";
import {
  composeCanonicalDatabase,
  canonicalDatabasePhysicalOperations,
  type CanonicalDatabaseOptions,
} from "./canonical-database-implementation.ts";
import type {
  ValidatedCanonicalDatabase,
} from "./canonical-schema-lifecycle.ts";

export const CANONICAL_SQLITE_FILE = "canonical.sqlite";

export type CanonicalDatabaseHandle = Omit<
  ValidatedCanonicalDatabase,
  "close"
> & Readonly<{
  db: ValidatedCanonicalDatabase;
  close(): void;
}>;

export function openCanonicalDatabaseHandle(
  ledgerDir: string,
  options: CanonicalDatabaseOptions = {},
): CanonicalDatabaseHandle {
  const lifecycle = composeCanonicalDatabase(
    ledgerDir === ":memory:"
      ? ledgerDir
      : join(ledgerDir, CANONICAL_SQLITE_FILE),
    options,
  );
  return Object.freeze({
    db: lifecycle.db,
    exec: lifecycle.db.exec,
    prepare: lifecycle.db.prepare,
    close: () => lifecycle.close(),
  }) as CanonicalDatabaseHandle;
}

declare const CANONICAL_DATABASE_WRITER_KEY: unique symbol;
export type CanonicalDatabaseWriterKey = string & {
  readonly [CANONICAL_DATABASE_WRITER_KEY]: true;
};

/**
 * Opaque coordination identity for the canonical writer queue. It is not a
 * database-open contract and cannot be constructed from an arbitrary path.
 */
export function canonicalDatabaseWriterKey(
  ledgerDir: string,
): CanonicalDatabaseWriterKey {
  return join(ledgerDir, CANONICAL_SQLITE_FILE) as CanonicalDatabaseWriterKey;
}

export type { CanonicalDatabaseOptions, ValidatedCanonicalDatabase };

// Existing domain code still consumes these operations while they are grouped
// into deeper interfaces. The public facade itself has no physical import or
// physical-module re-export; only its private composition root does.
export const {
  CANONICAL_SCHEMA_VERSION,
  CATHAY_INTEGRATION_NAMESPACE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
  CATHAY_DERIVED_ORIGIN,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2,
  FUBON_CREDIT_CARD_QUERY_ROUTES,
  ESUN_CREDIT_CARD_QUERY_ROUTES,
  YUANTA_CREDIT_CARD_QUERY_ROUTES,
  SCHEMA_V15_INVESTMENTS,
  SCHEMA_V16_INVESTMENT_FUNDING_RELATIONS,
  createCanonicalSchemaLifecyclePlan,
  isKnownRetiredFubonV18Fingerprint,
  isRetiredFubonV18RecoveryEligible,
  validateCanonicalInvestmentExtensionSchema,
  validateCanonicalInvestmentFundingRelationSchema,
  validateCanonicalLoanExtensionSchema,
  validateCanonicalLoanRepaymentRelationSchema,
  tableExists,
  relationType,
  columnExists,
  validateCanonicalContractPurgeSchema,
  validateCanonicalDatabaseAfterLifecycle,
  validateCanonicalSchemaMigrationMetadata,
  validateReadOnlyDatabase,
  validateV8SourceEvidenceSchema,
  validateCanonicalCompatibilityViews,
  validateCanonicalCaptureScopeLifecycleSchema,
  validateFinancialAccountCurrencyLifecycleSchema,
  validateCanonicalFinancialRevisionLifecycleSchema,
  validateCanonicalTimeObservationLifecycleSchema,
  validateCanonicalDepositoryBalanceSchema,
  validateForeignCurrencyConversionLifecycleSchema,
  ensureCanonicalEInvoiceSchema,
  validateCanonicalEInvoiceSchema,
  ensureCanonicalSpendingRecognitionSchema,
  validateCanonicalSpendingRecognitionSchema,
  hasCanonicalCreditCardExtension,
  hasFubonCreditCardExtension,
  canonicalCommitHasEvidence,
  validateGenerationExactAmounts,
  validateCanonicalAuthorityRoutes,
  recordProjectionGenerationEvent,
  validateGenerationTransactionIntegrity,
  validateGenerationFieldCompleteness,
  validateSelectedAssertionProvenance,
  validateGenerationFieldIntegrity,
  validateGenerationLifecycleCoordinates,
  validateUserAssertionProvenanceAuthority,
  validateProjectionGenerationProvenance,
  rejectStrayProjectionGenerations,
  projectionRelevantCommitCount,
  selectAssertionAsOf,
  validateCanonicalRelationResolutionCommitSchema,
  currentUtcMicros,
  quotedSqlIdentifier,
  isExactRetiredFubonV18BridgeState,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS,
} = canonicalDatabasePhysicalOperations;
