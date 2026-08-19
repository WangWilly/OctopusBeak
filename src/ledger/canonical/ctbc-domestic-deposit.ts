import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const CTBC_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "ctbc",
  authority: "ctbc/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "ctbcStatements",
  expectedRowWidth: 8,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis: "provider detailList fields and explicit no-data code 9201",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "pagination-termination",
  explicitNoDataEvidence: { kind: "code", code: "9201" },
} as const satisfies AdvertisedDomesticDepositContract;

export const CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-CTBC-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "100",
        "",
        "900",
        "",
      ],
    },
  ],
  transport: { pageNumbers: [1], terminalPageObserved: true },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightCtbcDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(CTBC_DOMESTIC_DEPOSIT_CONTRACT);
