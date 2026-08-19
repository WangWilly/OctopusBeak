import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const POST_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "post",
  authority: "post/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "postStatements",
  expectedRowWidth: 8,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis: "provider ITEM fields normalized through DR_FLG",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "none",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-POST-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/06/30" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "",
        "100",
        "100",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightPostDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(POST_DOMESTIC_DEPOSIT_CONTRACT);
