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

export const YUANTA_LOAN_SYNTHETIC_FIXTURE_V1 = LOAN_CONTRACT_FIXTURES.yuanta;

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

export function queryYuantaLoanCurrent(store: LoanFinancialStore) {
  return queryCanonicalLoanCurrent(store, { sourceId: "yuanta" });
}

export function queryYuantaLoanHistorical(
  store: LoanFinancialStore,
  request: LoanHistoricalQuery = {},
) {
  return queryCanonicalLoanHistorical(store, { ...request, sourceId: "yuanta" });
}

export function queryYuantaLoanLineage(
  store: LoanFinancialStore,
  request: LoanLineageQuery,
) {
  return queryCanonicalLoanLineage(store, { ...request, sourceId: "yuanta" });
}
