import {
  LOAN_CONTRACT_FIXTURES,
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
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
import { YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1 } from "./yuanta-loan-live-attestation.fixture.ts";

export {
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
} from "./loan-financial.ts";
export type {
  LoanCaptureInput as YuantaLoanCaptureInput,
  LoanFinancialStore,
  LoanHistoricalQuery,
  LoanLineageQuery,
  LoanValidatedCapture as YuantaLoanValidatedCapture,
} from "./loan-financial.ts";

export type YuantaLoanStatementRow = {
  transactionDate: string;
  postingDate: string;
  paymentItem: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
};

export type YuantaLoanCaptureBuildInput = {
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
  rows: readonly YuantaLoanStatementRow[];
};

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
  relationRule: "explicit-source-linkage-only",
  completeness: "source-declared-terminal-range",
  readiness: "canonical-synthetic",
} as const);

export const YUANTA_LOAN_FINANCIAL_AUTHORITY =
  YUANTA_LOAN_CONTRACT.authority;
export const YUANTA_LOAN_READINESS = YUANTA_LOAN_CONTRACT.readiness;
export const YUANTA_LOAN_CAPTURE_CONTRACT = YUANTA_LOAN_CONTRACT;

/** Versioned source-code table for the Yuanta loan statement's payment item. */
export const YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION =
  "yuanta/loan-source-event-codebook/v1" as const;

/** Exact provider labels/codes accepted by the Yuanta loan adapter. */
export const YUANTA_LOAN_SOURCE_EVENT_CODES: Readonly<Record<string, string>> =
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
    暫收款: "LOAN-PAYMENT",
    利息: "LOAN-INTEREST",
    繳息: "LOAN-INTEREST",
    利息支付: "LOAN-INTEREST",
    手續費: "LOAN-FEE",
    費用: "LOAN-FEE",
    違約金: "LOAN-FEE",
  });

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
  if (capture.sourceId !== "yuanta")
    throw new Error("Yuanta loan admission requires a Yuanta capture.");
  return admitCanonicalLoanCapture(capture);
}

export function commitYuantaLoanCapture(
  store: LoanFinancialStore,
  capture: LoanValidatedCapture,
) {
  return commitCanonicalLoanCapture(store, capture);
}

function normalizedSourceLabel(value: string): string {
  return value.normalize("NFKC").replace(/[\u00a0\u3000]/g, " ").replace(/\s+/gu, " ").trim();
}

function sourceCodeFor(label: string): string {
  const sourceCode = YUANTA_LOAN_SOURCE_EVENT_CODES[normalizedSourceLabel(label)];
  if (!sourceCode || !LOAN_EVENT_CONTRACT_MAPPINGS.yuanta[sourceCode])
    throw new CanonicalLoanAdmissionError(
      "Yuanta loan source event code is unsupported.",
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
  input: YuantaLoanCaptureBuildInput,
): CanonicalLoanStatementRow[] {
  return input.rows.map((row, index) => {
    const sourceCode = sourceCodeFor(row.paymentItem);
    const mapping = LOAN_EVENT_CONTRACT_MAPPINGS.yuanta[sourceCode]!;
    const effectiveDateText = row.postingDate || row.transactionDate;
    const effectiveOn = parseCanonicalLoanDate(
      effectiveDateText,
      "Yuanta loan effective date",
    );
    const sourceRecordKey = canonicalLoanToken(
      "yuanta",
      "loan-source-record-v1",
      input.accountValue,
      String(index),
      row.transactionDate,
      row.postingDate,
      row.paymentItem,
      row.transactionAmount,
      row.balanceAfterTransaction,
    );
    const amount = parseCanonicalLoanAmount(
      row.transactionAmount,
      "Yuanta loan transaction amount",
    );
    const balance = optionalAmount(
      row.balanceAfterTransaction,
      "Yuanta loan balance",
    );
    // Yuanta reports the balance after a transaction. The source only
    // distinguishes the transaction date; retain date precision and do not
    // manufacture an end-of-day timestamp from the posting date.
    const balanceEffectiveAt = parseCanonicalLoanDate(
      row.transactionDate,
      "Yuanta loan balance transaction date",
    );
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
      description: normalizedSourceLabel(row.paymentItem),
      ...(balanceIsHistorical
        ? {
            balance: {
              observationKey: canonicalLoanToken(
                "yuanta",
                "loan-balance-observation-v1",
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

export function buildYuantaLoanCapture(
  input: YuantaLoanCaptureBuildInput,
): LoanCaptureInput {
  const rows = canonicalRows(input);
  const identity = canonicalLoanSourceIdentity(
    "yuanta",
    input.sourceConnectionScope,
    input.accountValue,
  );
  return createCanonicalLoanCapture({
    captureId: canonicalLoanToken(
      "yuanta",
      "loan-capture-v1",
      input.sourceConnectionScope,
      input.accountValue,
      input.observedAt,
      input.startDate,
      input.endDate,
      ...rows.map((row) => row.sourceRecordKey),
    ),
    sourceId: "yuanta",
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
