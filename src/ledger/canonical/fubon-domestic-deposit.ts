import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const FUBON_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "fubon",
  authority: "fubon/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "fubonStatements",
  expectedRowWidth: 7,
  accountingDateIndex: 0,
  transactionDateIndex: 0,
  transactionTimeIndex: 1,
  provenance: {
    evidenceBasis: "normalized HTML table columns and next-page traversal",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 3,
  inflowIndex: 4,
  completenessEvidence: "pagination-termination",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-FUBON-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "",
        "100",
        "100",
        "SYNTHETIC",
      ],
    },
  ],
  transport: { pageNumbers: [1, 2], terminalPageObserved: true },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightFubonDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(FUBON_DOMESTIC_DEPOSIT_CONTRACT);
