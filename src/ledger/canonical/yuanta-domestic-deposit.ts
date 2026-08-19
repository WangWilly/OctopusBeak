import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const YUANTA_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "yuanta",
  authority: "yuanta/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "yuantaStatements",
  expectedRowWidth: 11,
  accountingDateIndex: 2,
  transactionDateIndex: 3,
  transactionTimeIndex: 4,
  provenance: {
    evidenceBasis: "downloaded CSV headers and normalized rows",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 6,
  inflowIndex: 7,
  completenessEvidence: "none",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-YUANTA-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/03/31" },
  records: [
    {
      values: [
        "SYNTHETIC",
        "SYNTHETIC-YUANTA-ACCOUNT",
        "20260102",
        "20260102",
        "09:10:11",
        "SYNTHETIC",
        "100",
        "",
        "900",
        "",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightYuantaDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(YUANTA_DOMESTIC_DEPOSIT_CONTRACT);
