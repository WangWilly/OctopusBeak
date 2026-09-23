import {
  LOAN_CONTRACT_FIXTURES,
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  admitCanonicalLoanCapture,
  commitCanonicalLoanCapture,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
  type LoanCaptureInput,
  type LoanFinancialStore,
  type LoanHistoricalQuery,
  type LoanLineageQuery,
  type LoanValidatedCapture,
} from "./loan-financial.ts";
import { YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1 } from "./yuanta-loan-live-attestation.fixture.ts";
import {
  YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  assertYuantaLoanCaptureAccountNumberEvidence,
  buildYuantaLoanCapture,
} from "./yuanta-loan-admission.ts";
import type { YuantaLoanCaptureBuildInput } from "./yuanta-loan-admission.ts";

export {
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
} from "./loan-financial.ts";
export type {
  LoanCaptureInput as YuantaLoanCaptureInput,
  LoanFinancialStore,
  LoanHistoricalQuery,
  LoanLineageQuery,
  LoanValidatedCapture as YuantaLoanValidatedCapture,
} from "./loan-financial.ts";

export {
  YUANTA_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  YUANTA_LOAN_SOURCE_EVENT_CODES,
  YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION,
  assertYuantaLoanCaptureAccountNumberEvidence,
  buildYuantaLoanCapture,
} from "./yuanta-loan-admission.ts";
export type {
  YuantaLoanAccountNumberEvidence,
  YuantaLoanCaptureBuildInput,
  YuantaLoanSourceOccurrenceAmbiguityDiagnostic,
  YuantaLoanStatementRow,
} from "./yuanta-loan-admission.ts";

export type YuantaLoanCaptureCommitDependencies = Partial<{
  admit: typeof admitYuantaLoanCapture;
  commit: typeof commitYuantaLoanCapture;
}>;

export const YUANTA_LOAN_CONTRACT = Object.freeze({
  source: "yuanta",
  stream: "loan",
  authority: "yuanta/loan/canonical-v1",
  contractVersion: "loan/canonical/v1.yuanta",
  workflow: "yuantaLoanStatements",
  accountType: "loan",
  amountDirection: "source-coded-loan-boundary",
  optionalFacts: "source-distinguished-only",
  balanceEffectiveTime: "source-reported-only",
  sourceOccurrenceIdentity: YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  legacySourceOccurrenceIdentity:
    YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  relationRule: "explicit-source-linkage-only",
  completeness: "source-declared-terminal-range",
  readiness: "canonical-synthetic",
} as const);

export const YUANTA_LOAN_FINANCIAL_AUTHORITY =
  YUANTA_LOAN_CONTRACT.authority;
export const YUANTA_LOAN_READINESS = YUANTA_LOAN_CONTRACT.readiness;
export const YUANTA_LOAN_CAPTURE_CONTRACT = YUANTA_LOAN_CONTRACT;

export const YUANTA_LOAN_SYNTHETIC_FIXTURE_V1 = LOAN_CONTRACT_FIXTURES.yuanta;

/**
 * Sanitized evidence contract for the solver-assisted live run.  It records
 * only source-contract facts and safe projection assertions; no account,
 * amount, description, response, or authentication value belongs here.
 */
export const YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-attestation/v1",
  sourceId: "yuanta",
  workflow: "yuantaLoanStatements",
  authorityRoute: YUANTA_LOAN_AUTHORITY_ROUTE,
  captureContractVersion: YUANTA_LOAN_CONTRACT_VERSION,
  sourceEventCodebookVersion: YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  validationMethod: "solver-assisted-electron-cdp",
  status: "verified-live-run",
  verifiedOn: "2026-09-01",
  runEvidenceSchemaVersion: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion,
  fieldEvidenceVersion: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion,
  fieldEvidenceId: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId,
  runEvidenceId: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId,
  runEvidenceArtifact: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.artifact,
  financialValuesRetained: false,
  authenticationSecretsRetained: false,
  rawSourcePayloadRetained: false,
  safeAssertions: Object.freeze([
    "identity:source-connection-and-loan-account-boundary-observed",
    "money:source-amount-and-loan-boundary-direction-observed",
    "time:source-transaction-and-balance-effective-time-observed",
    "status:source-event-codebook-observed",
    "completeness:provider-terminal-complete-range-observed",
    "queries:current-historical-lineage-reopen-observed",
  ]),
} as const);

function hasExactYuantaLoanSafeAssertions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions.length &&
    value.every(
      (assertion, index) =>
        assertion === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions[index],
    )
  );
}

function hasCompleteYuantaLoanFieldEvidence(): boolean {
  const evidence = YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1;
  return (
    evidence.observationProvenance.mode === "human-assisted-solver-live-run" &&
    evidence.observationProvenance.valuePolicy ===
      "field-shape-and-semantics-only" &&
    evidence.fieldObservations.identity.providerFields.length > 0 &&
    evidence.fieldObservations.identity.canonicalBindings.length > 0 &&
    evidence.fieldObservations.money.providerFields.length > 0 &&
    evidence.fieldObservations.money.directionBasis.length > 0 &&
    evidence.fieldObservations.time.providerFields.length > 0 &&
    evidence.fieldObservations.time.balanceEffectiveTimeBasis.length > 0 &&
    evidence.fieldObservations.status.providerFields.length > 0 &&
    evidence.fieldObservations.status.interpretation.length > 0 &&
    evidence.fieldObservations.completeness.providerSignals.length > 0 &&
    evidence.fieldObservations.completeness.terminalRule ===
      "yuanta-loan-terminal-v2" &&
    evidence.fieldObservations.queries.verifiedSurfaces.length > 0
  );
}

/** Readiness accepts only the exact sanitized live-evidence contract. */
export function isYuantaLoanLiveValidationAttestationValid(
  value: unknown,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const attestation = value as Record<string, unknown>;
  return (
    attestation.schemaVersion ===
      YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.schemaVersion &&
    attestation.sourceId === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.sourceId &&
    attestation.workflow === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.workflow &&
    attestation.authorityRoute === YUANTA_LOAN_AUTHORITY_ROUTE &&
    attestation.captureContractVersion === YUANTA_LOAN_CONTRACT_VERSION &&
    attestation.sourceEventCodebookVersion ===
      YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION &&
    attestation.validationMethod === "solver-assisted-electron-cdp" &&
    attestation.status === "verified-live-run" &&
    attestation.verifiedOn === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.verifiedOn &&
    attestation.runEvidenceSchemaVersion ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion &&
    attestation.fieldEvidenceVersion ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion &&
    attestation.fieldEvidenceId ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId &&
    attestation.runEvidenceId === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId &&
    attestation.runEvidenceArtifact ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.artifact &&
    attestation.financialValuesRetained === false &&
    attestation.authenticationSecretsRetained === false &&
    attestation.rawSourcePayloadRetained === false &&
    hasExactYuantaLoanSafeAssertions(attestation.safeAssertions) &&
    hasCompleteYuantaLoanFieldEvidence()
  );
}

export function validateYuantaLoanFixture(
  capture: LoanCaptureInput = YUANTA_LOAN_SYNTHETIC_FIXTURE_V1,
) {
  return admitYuantaLoanCapture(capture);
}

export function admitYuantaLoanCapture(
  capture: LoanCaptureInput,
): LoanValidatedCapture {
  assertYuantaLoanCaptureAccountNumberEvidence(capture);
  return admitCanonicalLoanCapture(capture);
}

export function commitYuantaLoanCapture(
  store: LoanFinancialStore,
  capture: LoanValidatedCapture,
) {
  return commitCanonicalLoanCapture(store, capture);
}

export async function persistYuantaLoanCapture(
  store: LoanFinancialStore,
  input: YuantaLoanCaptureBuildInput,
  dependencies: YuantaLoanCaptureCommitDependencies = {},
) {
  const admitted = (dependencies.admit ?? admitYuantaLoanCapture)(
    buildYuantaLoanCapture(input),
  );
  return (dependencies.commit ?? commitYuantaLoanCapture)(store, admitted);
}

export function queryYuantaLoanCurrent(store: LoanFinancialStore) {
  return queryCanonicalLoanCurrent(store, { sourceId: "yuanta" });
}

export function queryYuantaLoanHistorical(
  store: LoanFinancialStore,
  request: LoanHistoricalQuery,
) {
  return queryCanonicalLoanHistorical(store, { ...request, sourceId: "yuanta" });
}

export function queryYuantaLoanLineage(
  store: LoanFinancialStore,
  request: LoanLineageQuery,
) {
  return queryCanonicalLoanLineage(store, { ...request, sourceId: "yuanta" });
}
