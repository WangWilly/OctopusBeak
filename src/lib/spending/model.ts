import {
  SPENDING_CATEGORY_IDS,
  type SpendingCategory,
} from "./categories.ts";

export type SpendingItemDto = {
  itemKey: string;
  sequence: number | null;
  quantity: number | null;
  unitPrice: number | null;
  paidAmount: number;
  productName: string | null;
  category: SpendingCategory;
};

export type SpendingInvoiceDto = {
  invoiceKey: string;
  invoiceId: string;
  issuedAt: number;
  amount: number;
  sellerBusinessAccountNumber: string | null;
  sellerName: string | null;
  sellerAddr: string | null;
  items: SpendingItemDto[];
};

export type SpendingState = "included" | "excluded" | "pending";
export type SpendingSource = "invoice" | "account";
export type SpendingReason =
  | "direct_purchase"
  | "credit_card_payment"
  | "loan_payment"
  | "internal_transfer"
  | "invoice_duplicate"
  | "ambiguous_transfer"
  | "cash_withdrawal"
  | "unclassified";

export type SpendingAccountTransactionInput = {
  statementRowId: string;
  bank: string;
  accountNumber: string | null;
  currency: string;
  date: string;
  description: string | null;
  note: string | null;
  amount: number;
};

export type SpendingCardPaymentInput = {
  date: string;
  amount: number;
};

export type SpendingOverrideDto = {
  statementRowId: string;
  state: SpendingState;
  category: SpendingCategory | null;
  automaticState: SpendingState;
  automaticReason: SpendingReason | null;
  updatedAt: string;
};

export type SpendingAccountRecord = {
  key: string;
  source: "account";
  statementRowId: string;
  state: SpendingState;
  automaticState: SpendingState;
  automaticReason: SpendingReason;
  manual: boolean;
  date: string;
  label: string;
  amount: number;
  category: SpendingCategory;
};

export type SpendingInvoiceRecord = {
  key: string;
  source: "invoice";
  state: "included";
  date: string;
  label: string;
  amount: number;
  categories: SpendingCategory[];
  invoiceKey: string;
  accountStatementRowIds: string[];
};

export type SpendingDisplayRecord = SpendingInvoiceRecord | SpendingAccountRecord;

export type SpendingPageDto = {
  invoices: SpendingInvoiceDto[];
};

export type SpendingCategoryAmounts = Record<SpendingCategory, number>;
export type SpendingSourceAmounts = {
  invoice: SpendingCategoryAmounts;
  account: SpendingCategoryAmounts;
};
export type MonthlySpendingRow = SpendingSourceAmounts & {
  month: string;
  total: number;
};
export type DailySpendingRow = SpendingSourceAmounts & {
  date: string;
  total: number;
};
export type SpendingMonthSummary = {
  total: number;
  invoiceCount: number;
  accountCount: number;
};
export type SpendingDateGroup = {
  date: string;
  records: SpendingDisplayRecord[];
  includedTotal: number;
  excludedCount: number;
  pendingCount: number;
};
export type SpendingModel = {
  months: string[];
  monthlyRows: MonthlySpendingRow[];
  selectedMonth: string | null;
  selectedMonthSummary: SpendingMonthSummary;
  dailyRows: DailySpendingRow[];
  presentCategories: SpendingCategory[];
  invoices: SpendingInvoiceDto[];
  accountRecords: SpendingAccountRecord[];
  excludedAccountRecords: SpendingAccountRecord[];
  pendingAccountRecords: SpendingAccountRecord[];
  recordsByDate: SpendingDateGroup[];
};

export type BuildSpendingModelInput = {
  invoices: readonly SpendingInvoiceDto[];
  accountTransactions?: readonly SpendingAccountTransactionInput[];
  counterpartDeposits?: readonly SpendingAccountTransactionInput[];
  cardPayments?: readonly SpendingCardPaymentInput[];
  overrides?: readonly SpendingOverrideDto[];
  selectedMonth?: string;
  selectedCategory?: SpendingCategory;
};

const taipeiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function taipeiDateKey(unixSeconds: number): string {
  const parts = Object.fromEntries(
    taipeiDateFormatter.formatToParts(new Date(unixSeconds * 1000))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function categoryAmounts(): SpendingCategoryAmounts {
  return {
    food: 0,
    daily: 0,
    transport: 0,
    shopping: 0,
    home: 0,
    leisure: 0,
    other: 0,
  };
}

function addCategoryAmounts(
  target: SpendingCategoryAmounts,
  source: SpendingCategoryAmounts,
) {
  for (const category of SPENDING_CATEGORY_IDS) target[category] += source[category];
}

function sourceAmounts(): SpendingSourceAmounts {
  return { invoice: categoryAmounts(), account: categoryAmounts() };
}

function normalizedText(value: string | null): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function nearbyDate(left: string, right: string): boolean {
  return Math.abs(Date.parse(left) - Date.parse(right)) <= 2 * 86_400_000;
}

function matchingInvoice(
  row: SpendingAccountTransactionInput,
  invoices: readonly SpendingInvoiceDto[],
): SpendingInvoiceDto | undefined {
  const text = normalizedText(`${row.description ?? ""}${row.note ?? ""}`);
  return invoices.find((invoice) => {
    const seller = normalizedText(invoice.sellerName);
    return invoice.amount === row.amount && taipeiDateKey(invoice.issuedAt) === row.date &&
      text.length > 0 && seller.length > 0 && (text.includes(seller) || seller.includes(text));
  });
}

function automaticAccountDecision(
  row: SpendingAccountTransactionInput,
  deposits: readonly SpendingAccountTransactionInput[],
  invoices: readonly SpendingInvoiceDto[],
  cardPayments: readonly SpendingCardPaymentInput[],
): { state: SpendingState; reason: SpendingReason; category: SpendingCategory; invoiceKey?: string } {
  const text = normalizedText(`${row.description ?? ""}${row.note ?? ""}`);
  const excluded = (reason: SpendingReason, category: SpendingCategory = "other") =>
    ({ state: "excluded" as const, reason, category });

  if (/(放款繳款|貸款繳款|繳貸款|貸款扣款)/u.test(text)) return excluded("loan_payment");
  if (/(信用卡款|信用卡費|繳信用卡)/u.test(text) || cardPayments.some(
    (payment) => payment.amount === row.amount && nearbyDate(payment.date, row.date),
  )) return excluded("credit_card_payment");
  if (text.includes("自轉") || deposits.some((deposit) => {
    const accountNumber = normalizedText(deposit.accountNumber);
    return accountNumber.length > 0 && accountNumber !== normalizedText(row.accountNumber) &&
      text.includes(accountNumber);
  })) return excluded("internal_transfer");
  if (deposits.some((deposit) =>
    deposit.accountNumber !== row.accountNumber && deposit.currency === row.currency &&
    deposit.amount === row.amount && nearbyDate(deposit.date, row.date)
  )) return excluded("internal_transfer");

  const invoice = matchingInvoice(row, invoices);
  if (invoice) return {
    ...excluded("invoice_duplicate", invoice.items[0]?.category ?? "other"),
    invoiceKey: invoice.invoiceKey,
  };
  if (/(簽帳消費|金融卡消費|簽帳購物)/u.test(text)) {
    return { state: "included", reason: "direct_purchase", category: "other" };
  }
  if (/(提款|現金提領)/u.test(text)) {
    return { state: "pending", reason: "cash_withdrawal", category: "other" };
  }
  if (/(轉帳|轉出|匯款)/u.test(text)) {
    return { state: "pending", reason: "ambiguous_transfer", category: "other" };
  }
  return { state: "pending", reason: "unclassified", category: "other" };
}

export function buildSpendingModel(
  input: BuildSpendingModelInput,
): SpendingModel {
  const {
    invoices,
    accountTransactions = [],
    counterpartDeposits = [],
    cardPayments = [],
    overrides = [],
    selectedMonth,
    selectedCategory,
  } = input;
  const monthly = new Map<string, MonthlySpendingRow>();
  const derived: Array<{
    invoice: SpendingInvoiceDto;
    month: string;
    date: string;
    amounts: SpendingCategoryAmounts;
    categories: Set<SpendingCategory>;
  }> = [];

  for (const invoice of invoices) {
    const date = taipeiDateKey(invoice.issuedAt);
    const month = date.slice(0, 7);
    const amounts = categoryAmounts();
    const categories = new Set<SpendingCategory>();
    let itemTotal = 0;

    for (const item of invoice.items) {
      amounts[item.category] += item.paidAmount;
      itemTotal += item.paidAmount;
      categories.add(item.category);
    }

    const reconciliationCategory = invoice.items[0]?.category ?? "other";
    amounts[reconciliationCategory] += invoice.amount - itemTotal;
    categories.add(reconciliationCategory);

    const row = monthly.get(month) ?? { month, total: 0, ...sourceAmounts() };
    row.total += invoice.amount;
    addCategoryAmounts(row.invoice, amounts);
    monthly.set(month, row);
    derived.push({ invoice, month, date, amounts, categories });
  }

  const overrideById = new Map(overrides.map((override) => [override.statementRowId, override]));
  const duplicateInvoiceRows = new Map<string, string[]>();
  const accountRecords = accountTransactions.map((row): SpendingAccountRecord => {
    const automatic = automaticAccountDecision(row, counterpartDeposits, invoices, cardPayments);
    const override = overrideById.get(row.statementRowId);
    if (automatic.invoiceKey) {
      const ids = duplicateInvoiceRows.get(automatic.invoiceKey) ?? [];
      ids.push(row.statementRowId);
      duplicateInvoiceRows.set(automatic.invoiceKey, ids);
    }
    const record: SpendingAccountRecord = {
      key: `account:${row.statementRowId}`,
      source: "account",
      statementRowId: row.statementRowId,
      state: override?.state ?? automatic.state,
      automaticState: automatic.state,
      automaticReason: automatic.reason,
      manual: override !== undefined,
      date: row.date,
      label: row.description ?? row.note ?? row.bank,
      amount: row.amount,
      category: override?.category ?? automatic.category,
    };
    const month = row.date.slice(0, 7);
    const monthlyRow = monthly.get(month) ?? { month, total: 0, ...sourceAmounts() };
    if (record.state === "included") {
      monthlyRow.total += record.amount;
      monthlyRow.account[record.category] += record.amount;
    }
    monthly.set(month, monthlyRow);
    return record;
  });

  const months = [...monthly.keys()].sort();
  const activeMonth = selectedMonth ?? months.at(-1) ?? null;
  const daily = new Map<string, DailySpendingRow>();
  const present = new Set<SpendingCategory>();
  const filteredInvoices: SpendingInvoiceDto[] = [];
  const selectedMonthSummary = { total: 0, invoiceCount: 0, accountCount: 0 };
  const displayRecords: SpendingDisplayRecord[] = [];

  for (const entry of derived) {
    if (entry.month !== activeMonth) continue;
    selectedMonthSummary.total += entry.invoice.amount;
    selectedMonthSummary.invoiceCount += 1;
    for (const category of entry.categories) present.add(category);
    if (!selectedCategory || entry.categories.has(selectedCategory)) {
      filteredInvoices.push(entry.invoice);
      displayRecords.push({
        key: `invoice:${entry.invoice.invoiceKey}`,
        source: "invoice",
        state: "included",
        date: entry.date,
        label: entry.invoice.sellerName ?? entry.invoice.invoiceId,
        amount: entry.invoice.amount,
        categories: [...entry.categories],
        invoiceKey: entry.invoice.invoiceKey,
        accountStatementRowIds: duplicateInvoiceRows.get(entry.invoice.invoiceKey) ?? [],
      });
    }

    const row = daily.get(entry.date) ?? {
      date: entry.date,
      total: 0,
      ...sourceAmounts(),
    };
    row.total += entry.invoice.amount;
    addCategoryAmounts(row.invoice, entry.amounts);
    daily.set(entry.date, row);
  }

  const selectedAccountRecords = accountRecords.filter((record) =>
    record.date.slice(0, 7) === activeMonth
  );
  for (const record of selectedAccountRecords) {
    if (record.state === "included") {
      selectedMonthSummary.total += record.amount;
      selectedMonthSummary.accountCount += 1;
      present.add(record.category);
      const row = daily.get(record.date) ?? { date: record.date, total: 0, ...sourceAmounts() };
      row.total += record.amount;
      row.account[record.category] += record.amount;
      daily.set(record.date, row);
    }
    if (record.automaticReason !== "invoice_duplicate" &&
      (!selectedCategory || record.category === selectedCategory)) {
      displayRecords.push(record);
    }
  }

  const recordsByDate = [...Map.groupBy(displayRecords, (record) => record.date)]
    .map(([date, records]) => ({
      date,
      records,
      includedTotal: records.reduce(
        (total, record) => total + (record.state === "included" ? record.amount : 0),
        0,
      ),
      excludedCount: records.filter((record) => record.state === "excluded").length,
      pendingCount: records.filter((record) => record.state === "pending").length,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));

  return {
    months,
    monthlyRows: [...monthly.values()].sort((left, right) => left.month.localeCompare(right.month)),
    selectedMonth: activeMonth,
    selectedMonthSummary,
    dailyRows: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    presentCategories: SPENDING_CATEGORY_IDS.filter((category) => present.has(category)),
    invoices: filteredInvoices,
    accountRecords,
    excludedAccountRecords: selectedAccountRecords.filter((record) => record.state === "excluded"),
    pendingAccountRecords: selectedAccountRecords.filter((record) => record.state === "pending"),
    recordsByDate,
  };
}
