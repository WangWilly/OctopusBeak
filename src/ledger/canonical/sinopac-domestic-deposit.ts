import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";

export const SINOPAC_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "sinopac",
  authority: "sinopac/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "sinopacStatements",
  expectedRowWidth: 9,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis:
      "provider SubInfo/RecordCount fields and explicit FAIL no-data response",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "response-count",
  explicitNoDataEvidence: {
    kind: "status-message",
    status: "FAIL",
    message: "查無資料",
  },
} as const satisfies AdvertisedDomesticDepositContract;

export const SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-SINOPAC-ACCOUNT",
  scope: { startDate: "20260101", endDate: "20260131" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10",
        "SYNTHETIC",
        "100",
        "",
        "900",
        "",
        "",
      ],
    },
  ],
  transport: { reportedCount: 1 },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightSinopacDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(SINOPAC_DOMESTIC_DEPOSIT_CONTRACT);
