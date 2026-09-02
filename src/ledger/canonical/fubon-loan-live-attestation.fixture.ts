/**
 * Versioned, sanitized evidence for the Fubon loan v2 live run.  This module
 * intentionally contains only contract metadata and aggregate-safe assertions;
 * it is not a copy of the bank response or a durable financial record.
 */
export const FUBON_LOAN_LIVE_RUN_EVIDENCE_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-run-evidence/v1",
  fieldEvidenceVersion: "loan-live-field-observation/v1",
  fieldEvidenceId: "sha256:fubon-loan-v2-field-observation-20260831",
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
  observationProvenance: Object.freeze({
    mode: "human-assisted-solver-live-run",
    surface: "authenticated-provider-loan-statement",
    valuePolicy: "field-shape-and-semantics-only",
  }),
  fieldObservations: Object.freeze({
    identity: Object.freeze({
      providerFields: Object.freeze(["loan-account-selector"]),
      canonicalBindings: Object.freeze([
        "source-connection",
        "source-scoped-loan-account",
      ]),
    }),
    money: Object.freeze({
      providerFields: Object.freeze([
        "transaction-amount",
        "balance-after-transaction",
      ]),
      directionBasis: "provider-event-code-at-loan-boundary",
      precision: "source-decimal-text",
    }),
    time: Object.freeze({
      providerFields: Object.freeze(["transaction-date"]),
      transactionTimeBasis: "source-reported-date",
      balanceEffectiveTimeBasis: "source-transaction-date",
    }),
    status: Object.freeze({
      providerFields: Object.freeze(["transaction-content"]),
      interpretation: "versioned-provider-event-codebook",
    }),
    completeness: Object.freeze({
      providerSignals: Object.freeze([
        "result-table-shape",
        "current-page",
        "page-size",
        "next-control-state",
      ]),
      terminalRule: "fubon-loan-terminal-v2",
      rangeBasis: "requested-start-end-and-terminal-pagination",
    }),
    queries: Object.freeze({
      verifiedSurfaces: Object.freeze([
        "current",
        "historical-with-both-cutoffs",
        "lineage",
        "file-reopen",
      ]),
    }),
  }),
  safeAssertions: Object.freeze([
    "identity:source-connection-and-loan-account-boundary-observed",
    "money:source-amount-and-loan-boundary-direction-observed",
    "time:source-transaction-and-balance-effective-time-observed",
    "status:source-event-codebook-observed",
    "completeness:provider-terminal-complete-range-observed",
    "queries:current-historical-lineage-reopen-observed",
  ]),
} as const);
