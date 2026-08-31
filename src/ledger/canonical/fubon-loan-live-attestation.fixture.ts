/**
 * Versioned, sanitized evidence for the Fubon loan v2 live run.  This module
 * intentionally contains only contract metadata and aggregate-safe assertions;
 * it is not a copy of the bank response or a durable financial record.
 */
export const FUBON_LOAN_LIVE_RUN_EVIDENCE_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-run-evidence/v1",
  evidenceId: "sha256:fubon-loan-v2-live-run-evidence-20260831",
  artifact:
    "src/ledger/canonical/fubon-loan-live-attestation.fixture.ts#FUBON_LOAN_LIVE_RUN_EVIDENCE_V1",
  sourceId: "fubon",
  workflow: "fubonLoanStatements",
  authorityRoute: "fubon/loan/canonical-v2",
  captureContractVersion: "loan/canonical/v2.fubon",
  sourceEventCodebookVersion: "fubon/loan-source-event-codebook/v1",
  verifiedOn: "2026-08-31",
  financialValuesRetained: false,
  authenticationSecretsRetained: false,
  rawSourcePayloadRetained: false,
  safeAssertions: Object.freeze([
    "source-capture:nonzero",
    "loan-account-identity:nonzero",
    "loan-transaction-facts:nonzero",
    "current-loan-projection:nonzero",
    "loan-lineage:nonzero",
  ]),
} as const);
