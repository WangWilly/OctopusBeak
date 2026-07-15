import assert from "node:assert/strict";
import {
  createSourceCsvParser,
  normalizeCurrencyCode,
  personalInvoiceFields,
  personalInvoiceItemFields,
  personalInvoiceItemKey,
  personalInvoiceKey,
  sqliteAmount,
} from "./source-csv-parsers.ts";

assert.equal(sqliteAmount("8,054台幣"), 8054);
assert.equal(sqliteAmount("913,727台幣"), 913727);
assert.equal(normalizeCurrencyCode("美金"), "USD");
assert.equal(normalizeCurrencyCode("US/TWD"), "TWD");
assert.equal(normalizeCurrencyCode("0台幣", "USD"), "TWD");

const ctbcParser = createSourceCsvParser({
  bank: "ctbc",
  product: "statements",
  sourceRelativePath: "ctbc-statements/example.csv",
  metadata: { 帳號: "新臺幣-123456" },
  headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
});
assert.equal(ctbcParser.table, "account_transactions");
assert.deepEqual(
  ctbcParser.parseRow({
    帳務日期: "2026/07/03",
    交易日期: "2026/07/02",
    交易時間: "09:08:07",
    摘要: "薪資",
    支出金額: "0",
    存入金額: "1,234",
    即時餘額: "5,678",
    附註: "公司,入帳 七月",
  }),
  {
    account_name: "新臺幣-123456",
    account_number: "123456",
    currency: "TWD",
    accounting_date: "2026-07-03",
    transaction_date: "2026-07-02",
    transaction_time: "09:08:07",
    transaction_at_utc: "2026-07-02T01:08:07.000Z",
    description: "薪資",
    withdrawal_amount: 0,
    deposit_amount: 1234,
    balance_after: 5678,
    note: "公司,入帳 七月",
    fx_rate: null,
  },
);

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
    transaction_at_utc: "2026-07-04T01:15:02.000Z",
    description: "薪資",
    withdrawal_amount: null,
    deposit_amount: 123.45,
    balance_after: 1000,
    note: "備註",
    fx_rate: null,
  },
);

assert.equal(
  createSourceCsvParser({
    bank: "sinopac",
    product: "statements",
    sourceRelativePath: "sinopac-statements/example.csv",
    metadata: { 帳號: "123456 永豐" },
    headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
  }).table,
  "account_transactions",
);

const sinopacForeignParser = createSourceCsvParser({
  bank: "sinopac",
  product: "foreign-statements",
  sourceRelativePath: "sinopac-foreign-statements/example.csv",
  metadata: { 帳號: "123456 永豐", 幣別: "USD" },
  headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
});
assert.equal(sinopacForeignParser.table, "foreign_currency_transactions");
const sinopacForeignRow = sinopacForeignParser.parseRow({
  帳務日期: "2026/07/15",
  交易日期: "2026/07/15",
  交易時間: "12:02:03",
  摘要: "換匯",
});
assert.equal(sinopacForeignRow.transaction_date, "2026-07-15");
assert.equal(sinopacForeignRow.transaction_time, "12:02:03");
assert.equal(
  sinopacForeignRow.transaction_at_utc,
  "2026-07-15T04:02:03.000Z",
);

assert.equal(
  createSourceCsvParser({
    bank: "linebank",
    product: "statements",
    sourceRelativePath: "linebank-statements/example.csv",
    metadata: { 帳號: "123456 LINE Bank" },
    headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
  }).table,
  "account_transactions",
);

assert.equal(
  createSourceCsvParser({
    bank: "linebank",
    product: "foreign-statements",
    sourceRelativePath: "linebank-foreign-statements/example.csv",
    metadata: { 帳號: "123456 LINE Bank", 幣別: "USD" },
    headers: ["帳務日期", "交易日期", "交易時間", "摘要"],
  }).table,
  "foreign_currency_transactions",
);

const einvoicePayload = {
  carrier_customized_name: "mobile barcode",
  issued_at: "1783065600",
  invoice_id: "AB12345678",
  amount: "129",
  status: "confirmed",
  rebated: "false",
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
  item_sequence_number: "001",
  item_quantity: "2",
  item_unit_price: "50",
  item_paid_amount: "100",
  item_product_name: "Coffee",
};

const einvoiceParser = createSourceCsvParser({
  bank: "einvoice",
  product: "personal-invoices",
  sourceRelativePath: "einvoice-personal-invoices/example.csv",
  metadata: null,
  headers: Object.keys(einvoicePayload),
});
assert.equal(einvoiceParser.table, "personal_invoice_items");
assert.equal(
  personalInvoiceKey(einvoicePayload),
  "AB12345678|1783065600|24536806",
);
assert.equal(
  personalInvoiceItemKey(einvoicePayload),
  "AB12345678|1783065600|24536806|1",
);
assert.deepEqual(personalInvoiceFields(einvoicePayload), {
  invoice_key: "AB12345678|1783065600|24536806",
  carrier_customized_name: "mobile barcode",
  issued_at: 1783065600,
  invoice_id: "AB12345678",
  amount: 129,
  status: "confirmed",
  rebated: 0,
  seller_business_account_number: "24536806",
  seller_name: "Store",
  seller_addr: "Taipei",
  buyer_business_account_number: "",
});
assert.deepEqual(personalInvoiceItemFields(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: 1,
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});
assert.deepEqual(einvoiceParser.parseRow(einvoicePayload), {
  item_key: "AB12345678|1783065600|24536806|1",
  invoice_key: "AB12345678|1783065600|24536806",
  item_sequence_number: 1,
  item_quantity: 2,
  item_unit_price: 50,
  item_paid_amount: 100,
  item_product_name: "Coffee",
});

const zeroSequencePayload = {
  ...einvoicePayload,
  item_sequence_number: "0",
};
assert.equal(
  personalInvoiceItemKey(zeroSequencePayload),
  "AB12345678|1783065600|24536806|0",
);
assert.equal(
  personalInvoiceItemFields(zeroSequencePayload).item_sequence_number,
  0,
);

for (const invalidSequence of ["-1", "1.5", "item-1"]) {
  assert.throws(
    () => personalInvoiceItemFields({
      ...einvoicePayload,
      item_sequence_number: invalidSequence,
    }),
    /expected a non-negative decimal integer/,
  );
}

for (const blankSequence of ["", "   "]) {
  assert.throws(
    () => einvoiceParser.parseRow({
      ...einvoicePayload,
      item_sequence_number: blankSequence,
    }),
    /item_sequence_number is required/,
  );
}

const missingSequencePayload: Record<string, string> = { ...einvoicePayload };
delete missingSequencePayload.item_sequence_number;
assert.throws(
  () => einvoiceParser.parseRow(missingSequencePayload),
  /item_sequence_number is required/,
);

assert.throws(
  () => personalInvoiceItemFields({
    ...einvoicePayload,
    item_sequence_number: "9007199254740992",
  }),
  /exceeds the safe integer range/,
);
