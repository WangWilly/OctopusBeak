import assert from "node:assert/strict";
import {
  applySpendingAccountOverride,
  buildSpendingModel,
  parseTransferDestination,
  type SpendingAccountRecord,
  type SpendingAccountTransactionInput,
  type SpendingCardPaymentInput,
  type SpendingInvoiceRecord,
  type SpendingInvoiceDto,
} from "./model.ts";

const invoices: SpendingInvoiceDto[] = [
  {
    invoiceKey: "jan",
    invoiceId: "JAN00001",
    issuedAt: Date.parse("2026-01-15T04:00:00Z") / 1000,
    amount: 25,
    sellerBusinessAccountNumber: null,
    sellerName: "January seller",
    sellerAddr: null,
    items: [{
      itemKey: "jan-1",
      sequence: 1,
      quantity: 1,
      unitPrice: 25,
      paidAmount: 25,
      productName: "January item",
      category: "transport",
    }],
  },
  {
    invoiceKey: "feb-boundary",
    invoiceId: "FEB00001",
    issuedAt: Date.parse("2026-01-31T16:30:00Z") / 1000,
    amount: 100,
    sellerBusinessAccountNumber: "12345678",
    sellerName: "測試，商店",
    sellerAddr: "Taipei",
    items: [
      {
        itemKey: "feb-food-1",
        sequence: 1,
        quantity: 1,
        unitPrice: 80,
        paidAmount: 80,
        productName: "Meal",
        category: "food",
      },
      {
        itemKey: "feb-food-2",
        sequence: 2,
        quantity: 1,
        unitPrice: -20,
        paidAmount: -20,
        productName: "Refund",
        category: "food",
      },
      {
        itemKey: "feb-daily-1",
        sequence: 3,
        quantity: 1,
        unitPrice: 30,
        paidAmount: 30,
        productName: "Soap",
        category: "daily",
      },
    ],
  },
  {
    invoiceKey: "feb-empty",
    invoiceId: "FEB00002",
    issuedAt: Date.parse("2026-02-02T02:00:00Z") / 1000,
    amount: 50,
    sellerBusinessAccountNumber: null,
    sellerName: "No items",
    sellerAddr: null,
    items: [],
  },
  {
    invoiceKey: "feb-shopping",
    invoiceId: "FEB00003",
    issuedAt: Date.parse("2026-02-02T03:00:00Z") / 1000,
    amount: 30,
    sellerBusinessAccountNumber: null,
    sellerName: "Shop",
    sellerAddr: null,
    items: [
      {
        itemKey: "feb-shopping-1",
        sequence: 1,
        quantity: 1,
        unitPrice: 10,
        paidAmount: 10,
        productName: "Book",
        category: "shopping",
      },
      {
        itemKey: "feb-shopping-2",
        sequence: 2,
        quantity: 1,
        unitPrice: 20,
        paidAmount: 20,
        productName: "Pen",
        category: "shopping",
      },
    ],
  },
  {
    invoiceKey: "mar",
    invoiceId: "MAR00001",
    issuedAt: Date.parse("2026-03-03T04:00:00Z") / 1000,
    amount: 40,
    sellerBusinessAccountNumber: null,
    sellerName: "March seller",
    sellerAddr: null,
    items: [{
      itemKey: "mar-1",
      sequence: 1,
      quantity: 1,
      unitPrice: 40,
      paidAmount: 40,
      productName: "Ticket",
      category: "leisure",
    }],
  },
];

function accountRow(
  statementRowId: string,
  amount: number,
  description: string | null,
  date: string,
): SpendingAccountTransactionInput {
  return {
    statementRowId,
    bank: "test",
    accountNumber: "123456789",
    currency: "TWD",
    date,
    time: null,
    description,
    note: null,
    amount,
  };
}

assert.deepEqual(parseTransferDestination("06600000102281740 7097230279900200"), {
  bankCode: "066",
  accountNumber: "00000102281740",
});
assert.deepEqual(parseTransferDestination("0022016000081100"), {
  bankCode: "002",
  accountNumber: "2016000081100",
});
assert.equal(parseTransferDestination("reference 06600000102281740"), null);
assert.equal(parseTransferDestination("066-short"), null);
assert.equal(parseTransferDestination(null), null);

function depositRow(
  accountNumber: string,
  amount: number,
  date: string,
): SpendingAccountTransactionInput {
  return {
    ...accountRow(`deposit:${accountNumber}:${date}`, amount, "轉入", date),
    accountNumber,
  };
}

function cardPaymentRow(amount: number, date: string): SpendingCardPaymentInput {
  return { amount, date };
}

const accountTransactions: SpendingAccountTransactionInput[] = [
  accountRow("direct", 880, "簽帳消費 好市多", "2026-07-16"),
  accountRow("card-payment", 19_356, "玉山信用卡款", "2026-07-16"),
  accountRow("card-payment-match", 600, "自動扣款", "2026-07-16"),
  accountRow("loan-payment", 1_000, "放款繳款", "2026-07-15"),
  accountRow("self-transfer", 5_000, "自轉", "2026-07-15"),
  accountRow("mirrored", 3_000, "轉帳", "2026-07-14"),
  {
    ...accountRow("transfer", 1_500, "轉帳", "2026-07-14"),
    bank: "line-bank",
    accountNumber: "21732000021051",
    time: "17:27:28",
    note: "06600000102281740 7097230279900200",
  },
  accountRow("cash", 2_000, "提款", "2026-07-13"),
  accountRow("plain-payment", 300, "繳費", "2026-07-12"),
  accountRow("invoice-duplicate", 100, "測試商店", "2026-02-01"),
  accountRow("blank-merchant", 100, null, "2026-02-01"),
];

const input = {
  invoices,
  accountTransactions,
  counterpartDeposits: [depositRow("other-account", 3_000, "2026-07-15")],
  cardPayments: [cardPaymentRow(600, "2026-07-15")],
  overrides: [{
    statementRowId: "card-payment",
    state: "included" as const,
    category: "home" as const,
    automaticState: "excluded" as const,
    automaticReason: "credit_card_payment" as const,
    updatedAt: "2026-07-16T00:00:00.000Z",
  }],
};

const latest = buildSpendingModel(input);
assert.deepEqual(latest.months, ["2026-01", "2026-02", "2026-03", "2026-07"]);
assert.equal(latest.selectedMonth, "2026-07");
assert.deepEqual(
  latest.accountRecords.find((record) => record.statementRowId === "transfer"),
  {
    key: "account:transfer",
    source: "account",
    statementRowId: "transfer",
    state: "pending",
    automaticState: "pending",
    automaticReason: "ambiguous_transfer",
    automaticCategory: "other",
    duplicateInvoiceKey: undefined,
    manual: false,
    date: "2026-07-14",
    time: "17:27:28",
    label: "轉帳",
    bank: "line-bank",
    accountNumber: "21732000021051",
    currency: "TWD",
    note: "06600000102281740 7097230279900200",
    destinationBankCode: "066",
    destinationAccountNumber: "00000102281740",
    amount: 1_500,
    category: "other",
  },
);

const february = buildSpendingModel({ ...input, selectedMonth: "2026-02" });
assert.deepEqual(february.monthlyRows.map((row) => row.month), [
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-07",
]);
assert.deepEqual(
  february.monthlyRows.find((row) => row.month === "2026-02"),
  {
    month: "2026-02",
    total: 180,
    invoice: {
      food: 70,
      daily: 30,
      transport: 0,
      shopping: 30,
      home: 0,
      leisure: 0,
      other: 50,
    },
    account: {
      food: 0,
      daily: 0,
      transport: 0,
      shopping: 0,
      home: 0,
      leisure: 0,
      other: 0,
    },
  },
);
assert.deepEqual(february.selectedMonthSummary, { total: 180, invoiceCount: 3, accountCount: 0 });
assert.deepEqual(february.dailyRows, [
  {
    date: "2026-02-01",
    total: 100,
    invoice: {
      food: 70,
      daily: 30,
      transport: 0,
      shopping: 0,
      home: 0,
      leisure: 0,
      other: 0,
    },
    account: {
      food: 0,
      daily: 0,
      transport: 0,
      shopping: 0,
      home: 0,
      leisure: 0,
      other: 0,
    },
  },
  {
    date: "2026-02-02",
    total: 80,
    invoice: {
      food: 0,
      daily: 0,
      transport: 0,
      shopping: 30,
      home: 0,
      leisure: 0,
      other: 50,
    },
    account: {
      food: 0,
      daily: 0,
      transport: 0,
      shopping: 0,
      home: 0,
      leisure: 0,
      other: 0,
    },
  },
]);
assert.deepEqual(february.presentCategories, ["food", "daily", "shopping", "other"]);
assert.deepEqual(february.invoices.map((invoice) => invoice.invoiceKey), [
  "feb-boundary",
  "feb-empty",
  "feb-shopping",
]);

const food = buildSpendingModel({ ...input, selectedMonth: "2026-02", selectedCategory: "food" });
assert.deepEqual(food.invoices.map((invoice) => invoice.invoiceKey), ["feb-boundary"]);

assert.deepEqual(
  Object.fromEntries(latest.accountRecords.map((row) => [row.statementRowId, {
    state: row.state,
    automaticState: row.automaticState,
    reason: row.automaticReason,
    manual: row.manual,
    category: row.category,
  }])),
  {
    direct: { state: "included", automaticState: "included", reason: "direct_purchase", manual: false, category: "other" },
    "card-payment": { state: "included", automaticState: "excluded", reason: "credit_card_payment", manual: true, category: "home" },
    "card-payment-match": { state: "excluded", automaticState: "excluded", reason: "credit_card_payment", manual: false, category: "other" },
    "loan-payment": { state: "excluded", automaticState: "excluded", reason: "loan_payment", manual: false, category: "other" },
    "self-transfer": { state: "excluded", automaticState: "excluded", reason: "internal_transfer", manual: false, category: "other" },
    mirrored: { state: "excluded", automaticState: "excluded", reason: "internal_transfer", manual: false, category: "other" },
    transfer: { state: "pending", automaticState: "pending", reason: "ambiguous_transfer", manual: false, category: "other" },
    cash: { state: "pending", automaticState: "pending", reason: "cash_withdrawal", manual: false, category: "other" },
    "plain-payment": { state: "pending", automaticState: "pending", reason: "unclassified", manual: false, category: "other" },
    "invoice-duplicate": { state: "excluded", automaticState: "excluded", reason: "invoice_duplicate", manual: false, category: "food" },
    "blank-merchant": { state: "pending", automaticState: "pending", reason: "unclassified", manual: false, category: "other" },
  },
);
assert.deepEqual(latest.selectedMonthSummary, { total: 20_236, invoiceCount: 0, accountCount: 2 });
assert.deepEqual(latest.monthlyRows.find((row) => row.month === "2026-07"), {
  month: "2026-07",
  total: 20_236,
  invoice: { food: 0, daily: 0, transport: 0, shopping: 0, home: 0, leisure: 0, other: 0 },
  account: { food: 0, daily: 0, transport: 0, shopping: 0, home: 19_356, leisure: 0, other: 880 },
});
assert.deepEqual(latest.dailyRows, [{
  date: "2026-07-16",
  total: 20_236,
  invoice: { food: 0, daily: 0, transport: 0, shopping: 0, home: 0, leisure: 0, other: 0 },
  account: { food: 0, daily: 0, transport: 0, shopping: 0, home: 19_356, leisure: 0, other: 880 },
}]);
assert.deepEqual(latest.recordsByDate.map((group) => ({
  date: group.date,
  includedTotal: group.includedTotal,
  excludedCount: group.excludedCount,
  pendingCount: group.pendingCount,
})), [
  { date: "2026-07-16", includedTotal: 20_236, excludedCount: 1, pendingCount: 0 },
  { date: "2026-07-15", includedTotal: 0, excludedCount: 2, pendingCount: 0 },
  { date: "2026-07-14", includedTotal: 0, excludedCount: 1, pendingCount: 1 },
  { date: "2026-07-13", includedTotal: 0, excludedCount: 0, pendingCount: 1 },
  { date: "2026-07-12", includedTotal: 0, excludedCount: 0, pendingCount: 1 },
]);
assert.deepEqual(latest.excludedAccountRecords.map((row) => row.statementRowId), [
  "card-payment-match",
  "loan-payment",
  "self-transfer",
  "mirrored",
]);
assert.deepEqual(latest.pendingAccountRecords.map((row) => row.statementRowId), [
  "transfer",
  "cash",
  "plain-payment",
]);

const duplicateInvoice = february.recordsByDate
  .flatMap((group) => group.records)
  .find((record): record is SpendingInvoiceRecord =>
    record.source === "invoice" && record.invoiceKey === "feb-boundary"
  );
assert.deepEqual(duplicateInvoice?.accountStatementRowIds, ["invoice-duplicate"]);
assert.equal(february.excludedAccountRecords.some((row) => row.statementRowId === "invoice-duplicate"), true);
assert.equal(february.pendingAccountRecords.some((row) => row.statementRowId === "blank-merchant"), true);
assert.equal(february.recordsByDate.flatMap((group) => group.records)
  .some((record) => record.key === "account:invoice-duplicate"), false);

const compatibilityInvoice: SpendingInvoiceDto = {
  ...invoices[1],
  invoiceKey: "compatibility-merchant",
  invoiceId: "COMPAT01",
  amount: 77,
  sellerName: "SHOP1",
  items: [{
    ...invoices[1].items[0],
    itemKey: "compatibility-merchant-item",
    paidAmount: 77,
    unitPrice: 77,
  }],
};
const compatibilityModel = buildSpendingModel({
  invoices: [compatibilityInvoice],
  accountTransactions: [
    accountRow("compatibility-merchant", 77, "ＳＨＯＰ①", "2026-02-01"),
    accountRow("compatibility-account", 42, "轉帳至９８７６⑤", "2026-02-01"),
  ],
  counterpartDeposits: [depositRow("98765", 99, "2026-02-01")],
  selectedMonth: "2026-02",
});
assert.deepEqual(
  compatibilityModel.accountRecords.map((record) => [
    record.statementRowId,
    record.state,
    record.automaticReason,
  ]),
  [
    ["compatibility-merchant", "pending", "unclassified"],
    ["compatibility-account", "pending", "ambiguous_transfer"],
  ],
);
assert.deepEqual(
  compatibilityModel.recordsByDate
    .flatMap((group) => group.records)
    .find((record) => record.source === "invoice")
    ?.accountStatementRowIds,
  [],
);

const sameAccountTransfer = buildSpendingModel({
  invoices: [],
  accountTransactions: [{
    ...accountRow("same-account-transfer", 500, "轉帳", "2026-07-16"),
    accountNumber: "123-456",
  }],
  counterpartDeposits: [depositRow("123456", 500, "2026-07-16")],
});
assert.deepEqual(
  sameAccountTransfer.accountRecords.map((record) => [record.state, record.automaticReason]),
  [["pending", "ambiguous_transfer"]],
);

const manualDuplicate = buildSpendingModel({
  ...input,
  selectedMonth: "2026-02",
  overrides: [...input.overrides, {
    statementRowId: "invoice-duplicate",
    state: "included",
    category: "food",
    automaticState: "excluded",
    automaticReason: "invoice_duplicate",
    updatedAt: "2026-07-16T00:00:00.000Z",
  } as const],
});
const manualDuplicateGroup = manualDuplicate.recordsByDate.find((group) => group.date === "2026-02-01");
const manualDuplicateInvoice = manualDuplicateGroup?.records
  .find((record): record is SpendingInvoiceRecord =>
    record.source === "invoice" && record.invoiceKey === "feb-boundary"
  );
const manualDuplicateAccount = manualDuplicateGroup?.records
  .find((record): record is SpendingAccountRecord =>
    record.source === "account" && record.statementRowId === "invoice-duplicate"
  );
assert.deepEqual(manualDuplicateInvoice?.accountStatementRowIds, []);
assert.deepEqual(
  manualDuplicateAccount && {
    state: manualDuplicateAccount.state,
    manual: manualDuplicateAccount.manual,
    amount: manualDuplicateAccount.amount,
  },
  { state: "included", manual: true, amount: 100 },
);
assert.equal(manualDuplicateGroup?.includedTotal, 200);
assert.equal(manualDuplicateGroup?.records
  .filter((record) => record.state === "included")
  .reduce((total, record) => total + record.amount, 0), 200);
assert.equal(manualDuplicate.dailyRows.find((row) => row.date === "2026-02-01")?.total, 200);
assert.equal(JSON.parse(JSON.stringify({ invoices })).invoices.length, invoices.length);

const includedTransfer = applySpendingAccountOverride(latest, "transfer", "included", "shopping");
const includedTransferRecord = includedTransfer.accountRecords.find((record) =>
  record.statementRowId === "transfer"
);
assert.deepEqual(
  includedTransferRecord && {
    state: includedTransferRecord.state,
    category: includedTransferRecord.category,
    manual: includedTransferRecord.manual,
  },
  { state: "included", category: "shopping", manual: true },
);
assert.deepEqual(includedTransfer.selectedMonthSummary, {
  total: 21_736,
  invoiceCount: 0,
  accountCount: 3,
});
assert.equal(
  includedTransfer.monthlyRows.find((row) => row.month === "2026-07")?.account.shopping,
  1_500,
);
assert.equal(
  includedTransfer.dailyRows.find((row) => row.date === "2026-07-14")?.account.shopping,
  1_500,
);
assert.equal(includedTransfer.pendingAccountRecords.some((record) => record.statementRowId === "transfer"), false);
assert.deepEqual(
  includedTransfer.recordsByDate.find((group) => group.date === "2026-07-14") && {
    includedTotal: includedTransfer.recordsByDate.find((group) => group.date === "2026-07-14")?.includedTotal,
    excludedCount: includedTransfer.recordsByDate.find((group) => group.date === "2026-07-14")?.excludedCount,
    pendingCount: includedTransfer.recordsByDate.find((group) => group.date === "2026-07-14")?.pendingCount,
  },
  { includedTotal: 1_500, excludedCount: 1, pendingCount: 0 },
);

const restoredCardPayment = applySpendingAccountOverride(latest, "card-payment", null);
const restoredCardPaymentRecord = restoredCardPayment.accountRecords.find((record) =>
  record.statementRowId === "card-payment"
);
assert.deepEqual(
  restoredCardPaymentRecord && {
    state: restoredCardPaymentRecord.state,
    category: restoredCardPaymentRecord.category,
    manual: restoredCardPaymentRecord.manual,
  },
  { state: "excluded", category: "other", manual: false },
);
assert.deepEqual(restoredCardPayment.selectedMonthSummary, {
  total: 880,
  invoiceCount: 0,
  accountCount: 1,
});
assert.equal(restoredCardPayment.excludedAccountRecords.some((record) =>
  record.statementRowId === "card-payment"
), true);
