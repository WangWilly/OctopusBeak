import {
  LOAN_CONTRACT_FIXTURES,
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

export function queryFubonLoanCurrent(store: LoanFinancialStore) {
  return queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
}

export function queryFubonLoanHistorical(
  store: LoanFinancialStore,
  request: LoanHistoricalQuery = {},
) {
  return queryCanonicalLoanHistorical(store, { ...request, sourceId: "fubon" });
}

export function queryFubonLoanLineage(
  store: LoanFinancialStore,
  request: LoanLineageQuery,
) {
  return queryCanonicalLoanLineage(store, { ...request, sourceId: "fubon" });
}
