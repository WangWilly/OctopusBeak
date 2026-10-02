export type YuantaFundDetailQueryScope = Readonly<{
  paperno: string;
  trustno: string;
  inv_type: string;
  is_query: string;
  isFromFundDetail: string;
  is_fromFund: string;
}>;

export const yuantaFundDetailQueryScopeFields = [
  "paperno", "trustno", "inv_type", "is_query", "isFromFundDetail", "is_fromFund",
] as const;

/** The detail view scopes history through lowercase fields, not overview route parameters. */
export function yuantaFundHistoryQueryFields(
  source: YuantaFundDetailQueryScope,
  position: Readonly<{ txnType: string; paperNo: string; trustNo: string }>,
  startDate: string,
  endDate: string,
): Record<string, string> {
  if (position.txnType !== "FundSingleDetail" || !position.paperNo || !position.trustNo ||
    source.paperno !== position.paperNo || source.trustno !== position.trustNo ||
    source.inv_type !== "single" || source.is_query !== "Y" ||
    source.isFromFundDetail !== "Y" || source.is_fromFund !== "Y") {
    throw new Error("YuanTa fund history detail scope does not match the selected position.");
  }
  return {
    ...source,
    qry_option: "all_single",
    fundtransactiondetails_sdate: startDate,
    fundtransactiondetails_edate: endDate,
    TxnType: "FundSingleDetail",
  };
}

export function assertYuantaFundHistoryQueryRequest(
  body: URLSearchParams,
  expected: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(expected)) {
    const values = body.getAll(name);
    if (values.length !== 1 || values[0] !== value) {
      throw new Error("YuanTa fund history request does not prove the selected position and complete range.");
    }
  }
}
