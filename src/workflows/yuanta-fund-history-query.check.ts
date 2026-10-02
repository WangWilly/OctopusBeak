import assert from "node:assert/strict";
import {
  assertYuantaFundHistoryQueryRequest,
  yuantaFundHistoryQueryFields,
} from "./yuanta-fund-history-query.ts";

const position = { txnType: "FundSingleDetail", paperNo: "SANITIZED-LOT", trustNo: "YT01" };
const source = {
  paperno: position.paperNo, trustno: position.trustNo, inv_type: "single",
  is_query: "Y", isFromFundDetail: "Y", is_fromFund: "Y",
};
const fields = yuantaFundHistoryQueryFields(source, position, "2025/10/02", "2026/10/02");
assertYuantaFundHistoryQueryRequest(new URLSearchParams(fields), fields);

// Correct overview parameters cannot compensate for a wrong actual history filter.
for (const field of Object.keys(source)) {
  assert.throws(() => yuantaFundHistoryQueryFields(
    { ...source, [field]: "WRONG" }, position, "2025/10/02", "2026/10/02",
  ), /detail scope/u);
  const body = new URLSearchParams(fields);
  body.set(field, "WRONG");
  body.set("PapernNo", position.paperNo);
  body.set("TrustNo", position.trustNo);
  assert.throws(() => assertYuantaFundHistoryQueryRequest(body, fields), /selected position/u);
}
for (const field of Object.keys(fields)) {
  const missing = new URLSearchParams(fields);
  missing.delete(field);
  assert.throws(() => assertYuantaFundHistoryQueryRequest(missing, fields));
  const duplicate = new URLSearchParams(fields);
  duplicate.append(field, fields[field]);
  assert.throws(() => assertYuantaFundHistoryQueryRequest(duplicate, fields));
}
assert.throws(() => yuantaFundHistoryQueryFields(source,
  { ...position, txnType: "UNOBSERVED" }, "2025/10/02", "2026/10/02"));
console.log("YuanTa fund history query scope checks passed");
