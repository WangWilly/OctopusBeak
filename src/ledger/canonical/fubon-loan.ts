import {
  LOAN_CONTRACT_FIXTURES,
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
  rows: readonly FubonLoanStatementRow[];
};

export type FubonLoanCaptureCommitDependencies = Partial<{
  admit: typeof admitFubonLoanCapture;
  commit: typeof commitFubonLoanCapture;
}>;

export const FUBON_LOAN_CONTRACT = Object.freeze({
  source: "fubon",
  stream: "loan",
  authority: "fubon/loan/canonical-v1",
  contractVersion: "loan/canonical/v1.fubon",
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
  const observedAt = Date.parse(input.observedAt);
  return input.rows.map((row, index) => {
    const sourceCode = sourceCodeFor(row.transactionContent);
    const mapping = LOAN_EVENT_CONTRACT_MAPPINGS.fubon[sourceCode]!;
    const effectiveOn = parseCanonicalLoanDate(
      row.transactionDate,
      "Fubon loan transaction date",
    );
    const sourceRecordKey = canonicalLoanToken(
      "fubon",
      "loan-source-record-v1",
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
    const balanceEffectiveAt = `${effectiveOn}T23:59:59+08:00`;
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
      description: normalizedSourceLabel(row.transactionContent),
      ...(balanceIsHistorical
        ? {
            balance: {
              observationKey: canonicalLoanToken(
                "fubon",
                "loan-balance-observation-v1",
                sourceRecordKey,
              ),
              balance,
              effectiveAt: balanceEffectiveAt,
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
      "loan-capture-v1",
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
