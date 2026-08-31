import {
  LOAN_CONTRACT_FIXTURES,
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
  captureContractVersion: YUANTA_LOAN_CONTRACT_VERSION,
  sourceEventCodebookVersion: YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  validationMethod: "solver-assisted-electron-cdp",
  status: "pending",
  verifiedOn: null,
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
  const observedAt = Date.parse(input.observedAt);
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
      Number.isFinite(observedAt) &&
      Date.parse(balanceEffectiveAt) < observedAt;
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
