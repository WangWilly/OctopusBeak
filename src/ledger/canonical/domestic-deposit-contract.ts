export const DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS = [
  "provider-identity-guarantee-unproven",
  "posting-semantics-unproven",
  "effective-time-semantics-unproven",
  "cancellation-semantics-unproven",
  "completeness-semantics-unproven",
  "authority-semantics-unproven",
  "revision-semantics-unproven",
  "canonical-financial-writer-unavailable",
] as const;

export type DomesticDepositExactAmount = { coefficient: string; scale: number };

export type DomesticDepositSourceTime = {
  localDate: string;
  localTime: string;
  timeZone: "Asia/Taipei";
  epochMilliseconds: number;
  basis: "source_observed";
};
