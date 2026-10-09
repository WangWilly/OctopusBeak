/**
 * Source contracts for TDCC e-Passbook securities and funds (ADR 0041, ADR
 * 0042). TR002 Passbook movements and TR001 securities holdings share the
 * securities route on the `investment` stream. TR051V1 fund holdings have
 * their own route on the `investment-fund` stream, so a fund account is a
 * different product from a broker account.
 */
export const TDCC_INVESTMENT_ROUTE = "tdcc/investment/canonical-v1";
export const TDCC_INVESTMENT_CONTRACT = "tdcc/investment/canonical-v1";

export const TDCC_FUND_STREAM = "investment-fund";
export const TDCC_FUND_ROUTE = "tdcc/investment-fund/canonical-v1";
export const TDCC_FUND_CONTRACT = "tdcc/investment-fund/canonical-v1";
