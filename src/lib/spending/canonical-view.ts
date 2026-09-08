import { addExact, exactToNumber } from "../shared-money/exact.ts";
import type {
  CanonicalSpendingAmountDto,
  CanonicalSpendingCategoryDto,
  CanonicalSpendingRecordDto,
  CanonicalSpendingView,
} from "./model.ts";

export type CanonicalSpendingPeriod = Readonly<{
  month: string | null;
  transactions: readonly CanonicalSpendingRecordDto[];
  includedTransactions: readonly CanonicalSpendingRecordDto[];
  totalsByCurrency: readonly CanonicalSpendingAmountDto[];
  categoryTotalsByCurrency: CanonicalSpendingView["categoryTotalsByCurrency"];
  unclassifiedByCurrency: readonly CanonicalSpendingAmountDto[];
  classificationCoverage: CanonicalSpendingView["classificationCoverage"];
  reportEligibility: CanonicalSpendingView["reportEligibility"];
  totalStatus: CanonicalSpendingView["totalStatus"];
}>;

type CategoryTotal = CanonicalSpendingView["categoryTotalsByCurrency"][number];

function addAmount(
  previous: CanonicalSpendingAmountDto | undefined,
  value: CanonicalSpendingAmountDto,
): CanonicalSpendingAmountDto {
  if (!previous) return value;
  if (previous.currency !== value.currency)
    throw new Error("Canonical Spending period totals cannot mix currencies.");
  const exact = addExact(previous.exact, value.exact);
  return { currency: value.currency, exact, value: exactToNumber(exact) };
}

function addToAmountMap(
  values: Map<string, CanonicalSpendingAmountDto>,
  value: CanonicalSpendingAmountDto,
): void {
  values.set(value.currency, addAmount(values.get(value.currency), value));
}

function amountMap(values: Map<string, CanonicalSpendingAmountDto>): CanonicalSpendingAmountDto[] {
  return [...values.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function addCategory(
  values: Map<string, CategoryTotal>,
  category: {
    code: string;
    taxonomyId: string;
    taxonomyVersion: string;
    labels: CanonicalSpendingCategoryDto["labels"];
    amount: CanonicalSpendingAmountDto;
  },
): void {
  const key = `${category.code}|${category.taxonomyId}|${category.taxonomyVersion}|${category.amount.currency}`;
  const previous = values.get(key);
  values.set(key, {
    categoryCode: category.code,
    taxonomyId: category.taxonomyId,
    taxonomyVersion: category.taxonomyVersion,
    labels: category.labels,
    currency: category.amount.currency,
    amount: addAmount(previous?.amount, category.amount),
    count: (previous?.count ?? 0) + 1,
  });
}

function addRecordClassification(
  record: CanonicalSpendingRecordDto,
  classified: Map<string, CanonicalSpendingAmountDto>,
  unclassified: Map<string, CanonicalSpendingAmountDto>,
  categoryTotals: Map<string, CategoryTotal>,
): "classified" | "unclassified" {
  if (record.category.mode === "absent") {
    addToAmountMap(unclassified, record.amount);
    return "unclassified";
  }
  if (record.category.mode === "single") {
    addToAmountMap(classified, record.amount);
    if (record.category.code && record.category.taxonomyId && record.category.taxonomyVersion) {
      addCategory(categoryTotals, {
        code: record.category.code,
        taxonomyId: record.category.taxonomyId,
        taxonomyVersion: record.category.taxonomyVersion,
        labels: record.category.labels,
        amount: record.amount,
      });
    }
    return "classified";
  }
  let complete = record.category.components.length > 0;
  for (const component of record.category.components) {
    addCategory(categoryTotals, component);
    if (component.amount.currency !== record.amount.currency) complete = false;
  }
  if (complete) addToAmountMap(classified, record.amount);
  else addToAmountMap(unclassified, record.amount);
  return complete ? "classified" : "unclassified";
}

/**
 * Derive a month-scoped Spending view from the canonical all-time report.
 * Financial arithmetic stays exact; `value` is only a presentation field.
 */
export function scopeCanonicalSpendingView(
  view: CanonicalSpendingView,
  month: string | null,
): CanonicalSpendingPeriod {
  const transactions = view.transactions.filter((record) =>
    month === null || record.date.startsWith(`${month}-`),
  );
  const includedTransactions = transactions.filter((record) => record.inclusion === "included");
  const gaps = transactions.filter((record) => record.inclusion === "eligibility-gap");
  const totals = new Map<string, CanonicalSpendingAmountDto>();
  const classified = new Map<string, CanonicalSpendingAmountDto>();
  const unclassified = new Map<string, CanonicalSpendingAmountDto>();
  const categoryTotals = new Map<string, CategoryTotal>();
  let classifiedCount = 0;
  let unclassifiedCount = 0;
  for (const record of includedTransactions) {
    addToAmountMap(totals, record.amount);
    if (addRecordClassification(record, classified, unclassified, categoryTotals) === "classified") {
      classifiedCount += 1;
    } else {
      unclassifiedCount += 1;
    }
  }
  const gapAmounts = new Map<string, CanonicalSpendingAmountDto>();
  for (const gap of gaps) addToAmountMap(gapAmounts, gap.amount);
  const gapAmountByCurrency = amountMap(gapAmounts).map((amount) => ({ ...amount, count: gaps.filter((gap) => gap.amount.currency === amount.currency).length }));
  return {
    month,
    transactions,
    includedTransactions,
    totalsByCurrency: amountMap(totals),
    categoryTotalsByCurrency: [...categoryTotals.values()].sort((left, right) =>
      `${left.categoryCode}:${left.currency}`.localeCompare(`${right.categoryCode}:${right.currency}`),
    ),
    unclassifiedByCurrency: amountMap(unclassified),
    classificationCoverage: {
      includedCount: includedTransactions.length,
      classifiedCount,
      unclassifiedCount,
      includedAmountByCurrency: amountMap(totals),
      classifiedAmountByCurrency: amountMap(classified),
      unclassifiedAmountByCurrency: amountMap(unclassified),
    },
    reportEligibility: {
      status: gaps.length === 0 ? "complete" : "incomplete",
      gapCount: gaps.length,
      gapAmountByCurrency,
    },
    totalStatus: gaps.length === 0 ? "complete" : "incomplete",
  };
}

export function canonicalSpendingCategoryMatches(
  record: CanonicalSpendingRecordDto,
  category: string | null,
): boolean {
  if (!category) return true;
  if (record.inclusion !== "included") return false;
  if (category === "__unclassified") return record.category.mode === "absent";
  return record.category.mode === "single"
    ? record.category.code === category
    : record.category.mode === "allocated" && record.category.components.some((component) => component.code === category);
}

export function aggregateCanonicalByMonth(
  records: readonly CanonicalSpendingRecordDto[],
): readonly { month: string; amount: CanonicalSpendingAmountDto }[] {
  const amounts = new Map<string, CanonicalSpendingAmountDto>();
  for (const record of records) {
    const key = `${record.date.slice(0, 7)}|${record.amount.currency}`;
    amounts.set(key, addAmount(amounts.get(key), record.amount));
  }
  return [...amounts.entries()]
    .map(([key, amount]) => ({ month: key.slice(0, key.indexOf("|")), amount }))
    .sort((left, right) => left.month.localeCompare(right.month) || left.amount.currency.localeCompare(right.amount.currency));
}
