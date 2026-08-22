import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const HNCB_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "hncb",
  authority: "hncb/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "hncbStatements",
  expectedRowWidth: 11,
  accountingDateIndex: 2,
  transactionDateIndex: 0,
  transactionTimeIndex: 1,
  provenance: {
    evidenceBasis: "downloaded HTML workbook columns and provider no-data text",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "none",
  explicitNoDataEvidence: {
    kind: "message",
    pattern: /查\s*無\s*資\s*料|無\s*資\s*料|無\s*交\s*易|查\s*無\s*符\s*合/u,
  },
} as const satisfies AdvertisedDomesticDepositContract;

export const HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-HNCB-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "09:10:11",
        "2026/01/02",
        "TWD",
        "",
        "100",
        "100",
        "SYNTHETIC",
        "",
        "",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightHncbDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(HNCB_DOMESTIC_DEPOSIT_CONTRACT);
