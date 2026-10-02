import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";

export const yuantaFundHistoryInvestmentTypes = ["single", "type2", "type3"] as const;
export type YuantaFundHistoryInvestmentType = typeof yuantaFundHistoryInvestmentTypes[number];
export type YuantaFundAccountHistoryQuery = Readonly<{
  investmentType: YuantaFundHistoryInvestmentType;
  detail: "buy" | "deduct" | "sell" | "trans" | "profit" | "devide";
}>;

// Standing-instruction changes have no executed cash/units. Periodic purchases
// are reported in deduct, while single purchases are reported in buy.
export const yuantaFundAccountHistoryQueries: readonly YuantaFundAccountHistoryQuery[] =
  yuantaFundHistoryInvestmentTypes.flatMap(investmentType =>
    ([investmentType === "single" ? "buy" : "deduct", "sell", "trans", "profit", "devide"] as const)
      .map(detail => ({ investmentType, detail })));

export function yuantaFundAccountHistoryKey(type: YuantaFundHistoryInvestmentType): string {
  return `account-history:${type}`;
}

export function yuantaFundAccountHistoryType(key: string): YuantaFundHistoryInvestmentType | undefined {
  return yuantaFundHistoryInvestmentTypes.find(type => key === yuantaFundAccountHistoryKey(type));
}

export function yuantaFundAccountHistoryScope(type: YuantaFundHistoryInvestmentType): string {
  return deriveSourceConnectionIdentityKey("yuanta-fund-occurrence-scope", ["account-wide", type]);
}

export function yuantaFundAccountHistoryQueryFields(
  query: YuantaFundAccountHistoryQuery, startDate: string, endDate: string,
): Record<string, string> {
  if (!yuantaFundAccountHistoryQueries.some(q => q.investmentType === query.investmentType && q.detail === query.detail))
    throw new Error("YuanTa fund history query is outside the account history contract.");
  return {
    inv_type: query.investmentType, qry_option: query.detail, is_query: "Y", date_Type: "0",
    fundtransactiondetails_sdate: startDate, fundtransactiondetails_edate: endDate,
    // A retained detail-view filter must never narrow an account-wide query.
    paperno: "", trustno: "", TxnType: "", PapernNo: "", TrustNo: "", FundSummaryTrustNo: "",
  };
}

export const yuantaFundAccountHistoryTableLabels = {
  buy: "buy-details", deduct: "deduction-details", sell: "redemption-account-details",
  trans: "conversion-details", profit: "cash-dividend-details", devide: "unit-dividend-details",
} as const;
