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

export type SpendingPageDto = {
  invoices: SpendingInvoiceDto[];
};

export type SpendingCategoryAmounts = Record<SpendingCategory, number>;
export type MonthlySpendingRow = SpendingCategoryAmounts & {
  month: string;
  total: number;
};
export type DailySpendingRow = SpendingCategoryAmounts & {
  date: string;
  total: number;
};
export type SpendingMonthSummary = {
  total: number;
  invoiceCount: number;
};
export type SpendingModel = {
  months: string[];
  monthlyRows: MonthlySpendingRow[];
  selectedMonth: string | null;
  selectedMonthSummary: SpendingMonthSummary;
  dailyRows: DailySpendingRow[];
  presentCategories: SpendingCategory[];
  invoices: SpendingInvoiceDto[];
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

export function buildSpendingModel(
  invoices: readonly SpendingInvoiceDto[],
  selectedMonth?: string,
  selectedCategory?: SpendingCategory,
): SpendingModel {
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

    const row = monthly.get(month) ?? { month, total: 0, ...categoryAmounts() };
    row.total += invoice.amount;
    addCategoryAmounts(row, amounts);
    monthly.set(month, row);
    derived.push({ invoice, month, date, amounts, categories });
  }

  const months = [...monthly.keys()].sort();
  const activeMonth = selectedMonth ?? months.at(-1) ?? null;
  const daily = new Map<string, DailySpendingRow>();
  const present = new Set<SpendingCategory>();
  const filteredInvoices: SpendingInvoiceDto[] = [];
  const selectedMonthSummary = { total: 0, invoiceCount: 0 };

  for (const entry of derived) {
    if (entry.month !== activeMonth) continue;
    selectedMonthSummary.total += entry.invoice.amount;
    selectedMonthSummary.invoiceCount += 1;
    for (const category of entry.categories) present.add(category);
    if (!selectedCategory || entry.categories.has(selectedCategory)) {
      filteredInvoices.push(entry.invoice);
    }

    const row = daily.get(entry.date) ?? {
      date: entry.date,
      total: 0,
      ...categoryAmounts(),
    };
    row.total += entry.invoice.amount;
    addCategoryAmounts(row, entry.amounts);
    daily.set(entry.date, row);
  }

  return {
    months,
    monthlyRows: [...monthly.values()].sort((left, right) => left.month.localeCompare(right.month)),
    selectedMonth: activeMonth,
    selectedMonthSummary,
    dailyRows: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    presentCategories: SPENDING_CATEGORY_IDS.filter((category) => present.has(category)),
    invoices: filteredInvoices,
  };
}
