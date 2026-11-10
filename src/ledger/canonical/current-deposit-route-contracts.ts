import {
  TDCC_NAMESPACE,
  TDCC_SETTLEMENT_BALANCE_CONTRACT,
  TDCC_SETTLEMENT_BALANCE_ROUTE,
} from "./tdcc-settlement-contract.ts";

/**
 * Each current deposit balance route is declared once here. The PGlite
 * admission validates captures against it, the canonical route registry
 * derives its current-balance registrations from it, and provider workflows
 * read their response declarations from it (ADR 0123).
 */

export type CurrentDepositStream = "domestic-deposit" | "foreign-currency-deposit";

export type CurrentDepositEffectiveTimeBasis = "provider-http-date" | "provider-system-time";

export type CurrentDepositRequestDiscriminant = Readonly<{
  txnCode: string;
  bizCode: string;
  pageCount: number;
}>;

export type CurrentDepositRouteContract = Readonly<{
  integrationNamespace: string;
  stream: CurrentDepositStream;
  contractVersion: string;
  endpointHost: string;
  endpointPath: string;
  endpointQuery?: Readonly<Record<string, string>>;
  /** Additional query keys whose values are validated against a route pattern. */
  endpointQueryPatterns?: Readonly<Record<string, RegExp>>;
  /** Optional request discriminator for a shared provider endpoint. */
  requestResource?: string;
  /** Optional typed business-operation discriminator for a shared endpoint. */
  requestDiscriminant?: CurrentDepositRequestDiscriminant;
  effectiveTimeBasis: CurrentDepositEffectiveTimeBasis;
  effectiveTimeSourceField: string;
  /**
   * A provider system time written as Gregorian Asia/Taipei local
   * `YYYYMMDDhhmmss`, which carries no offset of its own.
   */
  systemTimeLexeme?: "taipei-yyyymmddhhmmss";
  /** Additional provider time evidence accepted by this route. */
  effectiveTimeAlternates?: readonly Readonly<{
    effectiveTimeBasis: CurrentDepositEffectiveTimeBasis;
    effectiveTimeSourceField: string;
  }>[];
  requiredCacheTokens: readonly string[];
  fields: Readonly<{
    ledger: readonly string[];
    available: readonly string[];
  }>;
}>;

export const CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS = Object.freeze({
  "cathay/domestic-deposit/current-balance-v1": {
    integrationNamespace: "cathay",
    stream: "domestic-deposit",
    contractVersion: "cathay/current-deposit-balance-v1",
    endpointHost: "www.cathaybk.com.tw",
    endpointPath:
      "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_DepositOverview",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "systemTime",
    requiredCacheTokens: [],
    fields: {
      ledger: ["accountBalance"],
      available: ["avaliableBalance"],
    },
  },
  "cathay/foreign-currency/current-balance-v1": {
    integrationNamespace: "cathay",
    stream: "foreign-currency-deposit",
    contractVersion: "cathay/current-deposit-balance-v1",
    endpointHost: "www.cathaybk.com.tw",
    endpointPath:
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_OverView",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "systemTime",
    requiredCacheTokens: [],
    fields: {
      ledger: ["balance"],
      available: [],
    },
  },
  "ctbc/domestic-deposit/current-balance-v1": {
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersion: "ctbc/current-deposit-balance-v1",
    endpointHost: "www.ctbcbank.com",
    endpointPath: "/IB/api/adapters/IB_Adapter/resource/ebmwResource",
    requestResource: "/twrbc-deposit/qu001/010",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "serverTime",
    requiredCacheTokens: ["no-cache", "no-store", "must-revalidate"],
    fields: {
      ledger: ["balance"],
      available: [],
    },
  },
  "fubon/domestic-deposit/current-balance-v1": {
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersion: "fubon/current-deposit-balance-v1",
    endpointHost: "ebank.taipeifubon.com.tw",
    endpointPath: "/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store", "no-cache"],
    fields: {
      ledger: ["即時餘額"],
      available: ["可用餘額"],
    },
  },
  "hncb/domestic-deposit/current-balance-v1": {
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersion: "hncb/current-deposit-balance-v1",
    endpointHost: "netbank.hncb.com.tw",
    endpointPath: "/netbank/servlet/TrxDispatcher",
    endpointQuery: { trx: "com.lb.wibc.trx.EAccDDSummary" },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳上餘額"],
      available: ["可用餘額"],
    },
  },
  "hncb/domestic-deposit/current-balance-overview-v1": {
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersion: "hncb/current-deposit-balance-overview-v1",
    endpointHost: "netbank.hncb.com.tw",
    endpointPath: "/netbank/servlet/TrxDispatcher",
    endpointQuery: {
      trx: "com.lb.wibc.trx.AcctInfoInq",
      state: "prompt",
    },
    endpointQueryPatterns: {
      time_str: /^\d{14}$/u,
    },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳上餘額"],
      available: ["原幣"],
    },
  },
  "sinopac/domestic-deposit/current-balance-v1": {
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersion: "sinopac/current-deposit-balance-v1",
    endpointHost: "mma.sinopac.com",
    endpointPath: "/ws/bank/bankbal/ws_bankbal.ashx",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: ["AvailBalance"],
      available: [],
    },
  },
  "sinopac/foreign-currency/current-balance-v1": {
    integrationNamespace: "sinopac",
    stream: "foreign-currency-deposit",
    contractVersion: "sinopac/current-deposit-balance-v1",
    endpointHost: "mma.sinopac.com",
    endpointPath: "/ws/bank/bankbal/ws_bankbal.ashx",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: ["AvailBalance"],
      available: [],
    },
  },
  "yuanta/domestic-deposit/current-balance-v1": {
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersion: "yuanta/current-deposit-balance-v1",
    endpointHost: "ebank.yuantabank.com.tw",
    endpointPath: "/nib/tx/finance_overview_for_summary",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳面餘額"],
      available: ["可用餘額"],
    },
  },
  "yuanta/foreign-currency/current-balance-v1": {
    integrationNamespace: "yuanta",
    stream: "foreign-currency-deposit",
    contractVersion: "yuanta/current-deposit-balance-v1",
    endpointHost: "ebank.yuantabank.com.tw",
    endpointPath: "/nib/tx/finance_overview_for_summary",
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["帳面餘額"],
      available: ["可用餘額"],
    },
  },
  "linebank/domestic-deposit/current-balance-v1": {
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersion: "linebank/current-deposit-balance-v1",
    endpointHost: "accessibility.linebank.com.tw",
    endpointPath: "/v1/account/common/payables",
    endpointQuery: { featureTypeCode: "01" },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    requiredCacheTokens: ["no-cache", "no-store"],
    fields: {
      ledger: [],
      available: ["wdrwAvblAmt"],
    },
  },
  [TDCC_SETTLEMENT_BALANCE_ROUTE]: {
    integrationNamespace: TDCC_NAMESPACE,
    stream: "domestic-deposit",
    contractVersion: TDCC_SETTLEMENT_BALANCE_CONTRACT,
    endpointHost: "epassbooksys.tdcc.com.tw",
    endpointPath: "/MPSBKV2/rest/tsp/TSP006",
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeSourceField: "updateTime",
    systemTimeLexeme: "taipei-yyyymmddhhmmss",
    requiredCacheTokens: [],
    fields: {
      ledger: ["balanceAmt"],
      available: ["availableBalance"],
    },
  },
  "post/domestic-deposit/current-balance-v1": {
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersion: "post/current-deposit-balance-v1",
    endpointHost: "ipost.post.gov.tw",
    endpointPath: "/pst/EsoafDispatcher",
    requestDiscriminant: {
      txnCode: "EB100103",
      bizCode: "getOverViewById",
      pageCount: 50,
    },
    effectiveTimeBasis: "provider-http-date",
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeAlternates: [
      {
        effectiveTimeBasis: "provider-system-time",
        effectiveTimeSourceField: "SERVER_TIMESTAMP",
      },
    ],
    requiredCacheTokens: ["no-store"],
    fields: {
      ledger: ["BAL"],
      available: [],
    },
  },
} as const satisfies Readonly<Record<string, CurrentDepositRouteContract>>);

export type CurrentDepositAuthorityRoute = keyof typeof CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS;
