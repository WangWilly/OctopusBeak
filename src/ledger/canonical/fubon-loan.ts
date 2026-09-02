import {
  LOAN_CONTRACT_FIXTURES,
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_CONTRACT_VERSION,
  CanonicalLoanAdmissionError,
  LOAN_EVENT_CONTRACT_MAPPINGS,
  admitCanonicalLoanCapture,
  canonicalLoanSourceIdentity,
  canonicalLoanToken,
  commitCanonicalLoanCapture,
  createCanonicalLoanCapture,
  parseCanonicalLoanAmount,
  parseCanonicalLoanDate,
  isCanonicalLoanSourceDateBeforeObservedAt,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
  type CanonicalLoanStatementRow,
  type LoanCaptureInput,
  type LoanFinancialStore,
  type LoanHistoricalQuery,
  type LoanLineageQuery,
  type LoanValidatedCapture,
} from "./loan-financial.ts";
import {
  FUBON_LOAN_LIVE_RUN_EVIDENCE_V1,
} from "./fubon-loan-live-attestation.fixture.ts";

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

export type FubonLoanStatementRow = {
  transactionDate: string;
  transactionContent: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
};

export type FubonLoanCaptureBuildInput = {
  accountValue: string;
  sourceConnectionScope: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  scope: LoanCaptureInput["scope"];
  pages: LoanCaptureInput["pages"];
  counterpartTransactions: LoanCaptureInput["counterpartTransactions"];
  relations: LoanCaptureInput["relations"];
  relationCoverage?: LoanCaptureInput["relationCoverage"];
  rows: readonly FubonLoanStatementRow[];
};

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

/** Exact provider labels/codes accepted by the Fubon loan adapter. */
export const FUBON_LOAN_SOURCE_EVENT_CODES: Readonly<Record<string, string>> =
  Object.freeze({
    "LOAN-DISBURSEMENT": "LOAN-DISBURSEMENT",
    "LOAN-PAYMENT": "LOAN-PAYMENT",
    "LOAN-INTEREST": "LOAN-INTEREST",
    "LOAN-FEE": "LOAN-FEE",
    撥款: "LOAN-DISBURSEMENT",
    放款: "LOAN-DISBURSEMENT",
    貸款撥款: "LOAN-DISBURSEMENT",
    還款: "LOAN-PAYMENT",
    繳款: "LOAN-PAYMENT",
    繳本: "LOAN-PAYMENT",
    本金: "LOAN-PAYMENT",
    本金還款: "LOAN-PAYMENT",
    本金攤還: "LOAN-PAYMENT",
    本息: "LOAN-PAYMENT",
    利息: "LOAN-INTEREST",
    繳息: "LOAN-INTEREST",
    利息支付: "LOAN-INTEREST",
    手續費: "LOAN-FEE",
    費用: "LOAN-FEE",
    違約金: "LOAN-FEE",
  });

export const FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION =
  "fubon/loan-source-event-codebook/v1" as const;

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
  if (capture.sourceId !== "fubon")
    throw new Error("Fubon loan admission requires a Fubon capture.");
  return admitCanonicalLoanCapture(capture);
}

export function commitFubonLoanCapture(
  store: LoanFinancialStore,
  capture: LoanValidatedCapture,
) {
  return commitCanonicalLoanCapture(store, capture);
}

function normalizedSourceLabel(value: string): string {
  return value.normalize("NFKC").replace(/[\u00a0\u3000]/g, " ").replace(/\s+/gu, " ").trim();
}

function sourceCodeFor(label: string): string {
  const sourceCode = FUBON_LOAN_SOURCE_EVENT_CODES[normalizedSourceLabel(label)];
  if (!sourceCode || !LOAN_EVENT_CONTRACT_MAPPINGS.fubon[sourceCode])
    throw new CanonicalLoanAdmissionError(
      "Fubon loan source event code is unsupported.",
    );
  return sourceCode;
}

function optionalAmount(value: string, label: string) {
  const normalized = normalizedSourceLabel(value);
  if (!normalized || ["-", "—", "N/A", "NA"].includes(normalized))
    return undefined;
  return parseCanonicalLoanAmount(normalized, label);
}

function canonicalRows(
  input: FubonLoanCaptureBuildInput,
): CanonicalLoanStatementRow[] {
  return input.rows.map((row, index) => {
    const sourceCode = sourceCodeFor(row.transactionContent);
    const mapping = LOAN_EVENT_CONTRACT_MAPPINGS.fubon[sourceCode]!;
    const effectiveOn = parseCanonicalLoanDate(
      row.transactionDate,
      "Fubon loan transaction date",
    );
    const sourceRecordKey = canonicalLoanToken(
      "fubon",
      "loan-source-record-v2",
      input.accountValue,
      String(index),
      row.transactionDate,
      row.transactionContent,
      row.transactionAmount,
      row.balanceAfterTransaction,
    );
    const amount = parseCanonicalLoanAmount(
      row.transactionAmount,
      "Fubon loan transaction amount",
    );
    const balance = optionalAmount(
      row.balanceAfterTransaction,
      "Fubon loan balance",
    );
    const balanceEffectiveAt = effectiveOn;
    const balanceIsHistorical =
      balance !== undefined &&
      isCanonicalLoanSourceDateBeforeObservedAt(
        balanceEffectiveAt,
        input.observedAt,
      );
    return {
      sourceRecordKey,
      occurrenceIndex: index + 1,
      effectiveOn,
      sourceTime: {
        localTime: "00:00:00",
        precision: "date",
        timeOrigin: "defaulted_local_midnight",
      },
      sourceCode,
      eventKind: mapping.eventKind,
      direction: mapping.direction,
      amount,
      description: normalizedSourceLabel(row.transactionContent),
      ...(balanceIsHistorical
        ? {
            balance: {
              observationKey: canonicalLoanToken(
                "fubon",
                "loan-balance-observation-v2",
                sourceRecordKey,
              ),
              balance,
              effectiveAt: balanceEffectiveAt,
              effectiveAtPrecision: "date",
              effectiveAtTimeOrigin: "source_reported",
              effectiveAtField: "transaction-date",
            },
          }
        : {}),
    };
  });
}

export function buildFubonLoanCapture(
  input: FubonLoanCaptureBuildInput,
): LoanCaptureInput {
  const rows = canonicalRows(input);
  const identity = canonicalLoanSourceIdentity(
    "fubon",
    input.sourceConnectionScope,
    input.accountValue,
  );
  return createCanonicalLoanCapture({
    captureId: canonicalLoanToken(
      "fubon",
      "loan-capture-v2",
      input.sourceConnectionScope,
      input.accountValue,
      input.observedAt,
      input.startDate,
      input.endDate,
      ...rows.map((row) => row.sourceRecordKey),
    ),
    sourceId: "fubon",
    identity,
    observedAt: input.observedAt,
    startDate: input.startDate,
    endDate: input.endDate,
    scope: input.scope,
    pages: input.pages,
    counterpartTransactions: input.counterpartTransactions,
    relations: input.relations,
    relationCoverage: input.relationCoverage,
    rows,
  });
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
