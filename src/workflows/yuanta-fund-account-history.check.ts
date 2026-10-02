import assert from "node:assert/strict";
import { yuantaFundAccountHistoryQueries, yuantaFundAccountHistoryScope,
  yuantaFundAccountHistoryQueryFields, yuantaFundSourceAmountCurrency } from "./yuanta-fund-account-history.ts";
import { assertYuantaFundHistoryQueryRequest } from "./yuanta-fund-history-query.ts";
assert.equal(yuantaFundAccountHistoryQueries.length, 15);
assert.equal(new Set(yuantaFundAccountHistoryQueries.map(q => `${q.investmentType}:${q.detail}`)).size, 15);
assert.equal(new Set(["single", "type2", "type3"].map(type => yuantaFundAccountHistoryScope(type as "single"))).size, 3);
for (const query of yuantaFundAccountHistoryQueries) {
  const fields = yuantaFundAccountHistoryQueryFields(query, "2020/01/01", "2026/10/02");
  assert.equal(fields.paperno, ""); assert.equal(fields.trustno, "");
  const body = new URLSearchParams(fields);
  assertYuantaFundHistoryQueryRequest(body, fields);
  body.set("trustno", "C001");
  assert.throws(() => assertYuantaFundHistoryQueryRequest(body, fields));
  const duplicate = new URLSearchParams(fields); duplicate.append("inv_type", query.investmentType);
  assert.throws(() => assertYuantaFundHistoryQueryRequest(duplicate, fields));
}
assert.throws(() => yuantaFundAccountHistoryQueryFields({ investmentType: "single", detail: "deduct" }, "2020/01/01", "2026/10/02"));
assert.equal(yuantaFundSourceAmountCurrency("台幣 1,000.25"), "TWD");
assert.equal(yuantaFundSourceAmountCurrency("USD 100"), "USD");
assert.equal(yuantaFundSourceAmountCurrency("1,000.25 台幣"), "TWD");
assert.equal(yuantaFundSourceAmountCurrency("100 USD"), "USD");
assert.equal(yuantaFundSourceAmountCurrency("美金 100"), "USD");
assert.equal(yuantaFundSourceAmountCurrency("100 美金"), "USD");
for (const value of ["100", "UNKNOWN 100", "USD -100", "USD 1,,000", "美元100 and 台幣200"])
  assert.throws(() => yuantaFundSourceAmountCurrency(value));
