/**
 * Source contract for TDCC e-Passbook settlement bank accounts (ADR 0041,
 * ADR 0042). TSP007 transaction history and TSP006 current balances are two
 * routes under the `tdcc` Intermediary-source namespace.
 */
export const TDCC_NAMESPACE = "tdcc";

export const TDCC_SETTLEMENT_DEPOSIT_ROUTE = "tdcc/domestic-deposit/settlement-v1";
export const TDCC_SETTLEMENT_DEPOSIT_CONTRACT = "tdcc/settlement-deposit-v1";
export const TDCC_SETTLEMENT_RECORD_KIND = "tdcc-settlement-deposit";
export const TDCC_SETTLEMENT_COMPLETENESS_BASIS = "tsp007-is-complete-range";

export const TDCC_SETTLEMENT_BALANCE_ROUTE = "tdcc/domestic-deposit/current-balance-v1";
export const TDCC_SETTLEMENT_BALANCE_CONTRACT = "tdcc/current-deposit-balance-v1";

/**
 * The one route profile both the canonical admission and the PGlite deposit
 * command check a TSP007 capture against. The stream is `domestic-deposit`
 * for every currency because each TDCC account has exactly one currency.
 */
export const TDCC_SETTLEMENT_DEPOSIT_PROFILE = Object.freeze({
  postingOrigin: "provider_booked_history",
  postingBasis: "statement-posted-history",
  effectiveTimeBasis: "transaction-time",
  postingStatus: "posted",
  timeZone: "Asia/Taipei",
  timePrecision: "second",
  completeness: "complete-range",
  completenessBasis: TDCC_SETTLEMENT_COMPLETENESS_BASIS,
  completenessRuleVersion: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
  absenceAuthority: "provider-explicit-no-data",
  absenceAuthorityOnlyWhenEmpty: true,
  withdrawalPolicy: "never-infer",
  integrationNamespace: TDCC_NAMESPACE,
  stream: "domestic-deposit",
  recordKind: TDCC_SETTLEMENT_RECORD_KIND,
  accountType: "depository",
  contractVersion: TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
  requireProviderGuaranteedFalse: true,
} as const);
