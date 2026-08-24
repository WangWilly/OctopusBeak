import type { ForeignCurrencyDepositCaptureInput } from "./foreign-currency-deposit.ts";

/** Synthetic, versioned source contracts used by readiness and admission checks. */
const shared = {
  accountNo: "FIXTURE-ACCOUNT-133",
  accountType: "depository",
  sourceConnectionKey: "fixture-login-133",
  identityEpochKey: "fixture-identity-133",
  observedAt: "2026-08-24T12:00:00+08:00",
  startDate: "2026-08-01",
  endDate: "2026-08-24",
  completeness: "complete-range" as const,
};

function fixture(
  source: ForeignCurrencyDepositCaptureInput["source"],
  currency: string,
  sequence: string,
): ForeignCurrencyDepositCaptureInput {
  return {
    ...shared,
    source,
    records: [
      {
        sourceKey: `${source}-fixture-${sequence}`,
        sequence,
        amount: "10.25",
        direction: "inflow",
        currencyEvidence: { kind: "row", currency },
        balanceAfter: "100.25",
        sourceTime: { localDate: "2026-08-02", localTime: "09:10" },
        originalAmount: { amount: "10.25", currency },
        description: `${source} foreign fixture`,
      },
    ],
  };
}

export const YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 = fixture(
  "yuanta",
  "USD",
  "1",
);
export const CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 = fixture(
  "cathay",
  "EUR",
  "1",
);
export const SINOPAC_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 = fixture(
  "sinopac",
  "JPY",
  "1",
);
export const LINEBANK_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 = fixture(
  "linebank",
  "GBP",
  "1",
);

export const FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 = [
  YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1,
  CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1,
  SINOPAC_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1,
  LINEBANK_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1,
] as const;
