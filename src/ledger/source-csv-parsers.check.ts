import assert from "node:assert/strict";
import {
  createSourceCsvParser,
  normalizeCurrencyCode,
  sqliteAmount,
} from "./source-csv-parsers.ts";

assert.equal(sqliteAmount("8,054台幣"), 8054);
assert.equal(sqliteAmount("913,727台幣"), 913727);
assert.equal(normalizeCurrencyCode("美金"), "USD");
assert.equal(normalizeCurrencyCode("US/TWD"), "TWD");
assert.equal(normalizeCurrencyCode("0台幣", "USD"), "TWD");

const postParser = createSourceCsvParser({
  bank: "post",
  product: "statements",
  sourceRelativePath: "post-statements/example.csv",
  metadata: { 帳號: "123456 郵局" },
  headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
});
assert.equal(postParser.table, "account_transactions");
assert.deepEqual(
  postParser.parseRow({
    帳務日期: "2026/07/04",
    交易日期: "2026/07/04",
    交易時間: "09:15:02",
    摘要: "薪資",
    支出金額: "",
    存入金額: "123.45",
    即時餘額: "1000.00",
    附註: "備註",
  }),
  {
    account_name: "郵局",
    account_number: "123456",
    currency: "TWD",
    accounting_date: "2026-07-04",
    transaction_date: "2026-07-04",
    transaction_time: "09:15:02",
    description: "薪資",
    withdrawal_amount: null,
    deposit_amount: 123.45,
    balance_after: 1000,
    note: "備註",
    fx_rate: null,
  },
);
