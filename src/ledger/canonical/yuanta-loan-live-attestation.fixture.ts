/**
 * Versioned, sanitized evidence for the Yuanta loan v1 live run. This module
 * retains contract metadata and aggregate-safe assertions only; it is neither
 * a bank response nor a durable financial record.
 */
export const YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-run-evidence/v1",
  fieldEvidenceVersion: "loan-live-field-observation/v1",
  fieldEvidenceId: "sha256:yuanta-loan-v1-field-observation-20260901",
  evidenceId: "sha256:yuanta-loan-v1-live-run-evidence-20260901",
  artifact:
    "src/ledger/canonical/yuanta-loan-live-attestation.fixture.ts#YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1",
  sourceId: "yuanta",
  workflow: "yuantaLoanStatements",
  authorityRoute: "yuanta/loan/canonical-v1",
  captureContractVersion: "loan/canonical/v1.yuanta",
  sourceEventCodebookVersion: "yuanta/loan-source-event-codebook/v1",
  verifiedOn: "2026-09-01",
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
      directionBasis: "provider-payment-item-at-loan-boundary",
      precision: "source-decimal-text",
    }),
    time: Object.freeze({
      providerFields: Object.freeze(["transaction-date", "posting-date"]),
      transactionTimeBasis: "source-posting-date-with-transaction-date-fallback",
      balanceEffectiveTimeBasis: "source-transaction-date",
    }),
    status: Object.freeze({
      providerFields: Object.freeze(["payment-item"]),
      interpretation: "versioned-provider-event-codebook",
    }),
    completeness: Object.freeze({
      providerSignals: Object.freeze([
        "six-column-result-table",
        "current-page",
        "page-size",
        "next-control-state",
      ]),
      terminalRule: "yuanta-loan-terminal-v2",
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
