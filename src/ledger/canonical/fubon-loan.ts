import {
  LOAN_CONTRACT_FIXTURES,
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_CONTRACT_VERSION,
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
import {
  buildFubonLoanCapture,
  FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  assertFubonLoanCaptureAccountNumberEvidence,
} from "./fubon-loan-admission.ts";
import type { FubonLoanCaptureBuildInput } from "./fubon-loan-admission.ts";
import {
  FUBON_LOAN_LIVE_RUN_EVIDENCE_V1,
} from "./fubon-loan-live-attestation.fixture.ts";

export {
  FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  FUBON_LOAN_SOURCE_EVENT_CODES,
  FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  buildFubonLoanCapture,
} from "./fubon-loan-admission.ts";
export type {
  FubonLoanAccountNumberEvidence,
  FubonLoanCaptureBuildInput,
  FubonLoanStatementRow,
} from "./fubon-loan-admission.ts";

export {
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_CONTRACT_VERSION,
} from "./loan-financial.ts";
export type {
  LoanCaptureInput as FubonLoanCaptureInput,
  LoanFinancialStore,
  LoanHistoricalQuery,
  LoanLineageQuery,
  LoanValidatedCapture as FubonLoanValidatedCapture,
} from "./loan-financial.ts";

export type FubonLoanCaptureCommitDependencies = Partial<{
  admit: typeof admitFubonLoanCapture;
  commit: typeof commitFubonLoanCapture;
}>;

export const FUBON_LOAN_CONTRACT = Object.freeze({
  source: "fubon",
  stream: "loan",
  authority: FUBON_LOAN_AUTHORITY_ROUTE,
  contractVersion: FUBON_LOAN_CONTRACT_VERSION,
  workflow: "fubonLoanStatements",
  accountType: "loan",
  amountDirection: "source-coded-loan-boundary",
  optionalFacts: "source-distinguished-only",
  balanceEffectiveTime: "source-reported-only",
  relationRule: "explicit-source-linkage-only",
  completeness: "source-declared-terminal-range",
  readiness: "canonical-synthetic",
} as const);

export const FUBON_LOAN_FINANCIAL_AUTHORITY =
  FUBON_LOAN_CONTRACT.authority;
export const FUBON_LOAN_READINESS = FUBON_LOAN_CONTRACT.readiness;
export const FUBON_LOAN_CAPTURE_CONTRACT = FUBON_LOAN_CONTRACT;

/** Sanitized evidence recorded only after the solver-assisted live workflow
 * has produced non-zero canonical loan projections. */
export const FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-attestation/v1",
  sourceId: "fubon",
  workflow: "fubonLoanStatements",
  authorityRoute: FUBON_LOAN_AUTHORITY_ROUTE,
  captureContractVersion: FUBON_LOAN_CONTRACT_VERSION,
  sourceEventCodebookVersion: FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  validationMethod: "solver-assisted-electron-cdp",
  status: "verified-live-run",
  verifiedOn: "2026-08-31",
  runEvidenceSchemaVersion: FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion,
  fieldEvidenceVersion: FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion,
  fieldEvidenceId: FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId,
  runEvidenceId: FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId,
  runEvidenceArtifact: FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.artifact,
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

function hasExactFubonLoanSafeAssertions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions.length &&
    value.every(
      (assertion, index) =>
        assertion === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions[index],
    )
  );
}

function hasCompleteFubonLoanFieldEvidence(): boolean {
  const evidence = FUBON_LOAN_LIVE_RUN_EVIDENCE_V1;
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
      "fubon-loan-terminal-v2" &&
    evidence.fieldObservations.queries.verifiedSurfaces.length > 0
  );
}

/**
 * Readiness may consume only the immutable attestation shape recorded with
 * the sanitized run evidence. A copied object with a manually changed status
 * is rejected unless every source, contract, date, privacy, assertion, and
 * durable-evidence binding still matches this version.
 */
export function isFubonLoanLiveValidationAttestationValid(
  value: unknown,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const attestation = value as Record<string, unknown>;
  return (
    attestation.schemaVersion ===
      FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.schemaVersion &&
    attestation.sourceId === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.sourceId &&
    attestation.workflow === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.workflow &&
    attestation.authorityRoute ===
      FUBON_LOAN_AUTHORITY_ROUTE &&
    attestation.captureContractVersion === FUBON_LOAN_CONTRACT_VERSION &&
    attestation.sourceEventCodebookVersion ===
      FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION &&
    attestation.validationMethod === "solver-assisted-electron-cdp" &&
    attestation.status === "verified-live-run" &&
    attestation.verifiedOn === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.verifiedOn &&
    attestation.runEvidenceSchemaVersion ===
      FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion &&
    attestation.fieldEvidenceVersion ===
      FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion &&
    attestation.fieldEvidenceId ===
      FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId &&
    attestation.runEvidenceId === FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId &&
    attestation.runEvidenceArtifact ===
      FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.artifact &&
    attestation.financialValuesRetained === false &&
    attestation.authenticationSecretsRetained === false &&
    attestation.rawSourcePayloadRetained === false &&
    hasExactFubonLoanSafeAssertions(attestation.safeAssertions) &&
    hasCompleteFubonLoanFieldEvidence()
  );
}

export const FUBON_LOAN_SYNTHETIC_FIXTURE_V1 = LOAN_CONTRACT_FIXTURES.fubon;

export function validateFubonLoanFixture(
  capture: LoanCaptureInput = FUBON_LOAN_SYNTHETIC_FIXTURE_V1,
) {
  return admitFubonLoanCapture(capture);
}

export function admitFubonLoanCapture(
  capture: LoanCaptureInput,
): LoanValidatedCapture {
  assertFubonLoanCaptureAccountNumberEvidence(capture);
  return admitCanonicalLoanCapture(capture);
}

export function commitFubonLoanCapture(
  store: LoanFinancialStore,
  capture: LoanValidatedCapture,
) {
  return commitCanonicalLoanCapture(store, capture);
}

export async function persistFubonLoanCapture(
  store: LoanFinancialStore,
  input: FubonLoanCaptureBuildInput,
  dependencies: FubonLoanCaptureCommitDependencies = {},
) {
  const admitted = (dependencies.admit ?? admitFubonLoanCapture)(
    buildFubonLoanCapture(input),
  );
  return (dependencies.commit ?? commitFubonLoanCapture)(store, admitted);
}

export function queryFubonLoanCurrent(store: LoanFinancialStore) {
  return queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
}

export function queryFubonLoanHistorical(
  store: LoanFinancialStore,
  request: LoanHistoricalQuery,
) {
  return queryCanonicalLoanHistorical(store, { ...request, sourceId: "fubon" });
}

export function queryFubonLoanLineage(
  store: LoanFinancialStore,
  request: LoanLineageQuery,
) {
  return queryCanonicalLoanLineage(store, { ...request, sourceId: "fubon" });
}
