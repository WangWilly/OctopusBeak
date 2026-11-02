import type { PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import { exactFromManualAmount } from "../manual-assets/manual-assets.ts";
import { addKeepingScale, exactToNumber, type ExactAmount } from "../shared-money/exact-money.ts";
import type { SpendingPageDto, SpendingPurchaseReportSummaryDto } from "./model.ts";

/**
 * A Manual Account purchase as Spending counts it: an outflow in the
 * account's currency with its Personal Category. It never joins pairing,
 * deduplication, or the canonical record pages.
 */
export type ManualSpendingPurchase = Readonly<{
  transactionId: string;
  accountId: string;
  accountName: string;
  occurredOn: string;
  amount: string;
  currency: string;
  personalCategory: PersonalCategoryCode | null;
  note: string | null;
}>;

export type ManualSpendingDto = Readonly<{
  /** The Manual Asset revision these purchases were read at. */
  revision: number;
  /** Newest first. */
  purchases: readonly ManualSpendingPurchase[];
}>;

type Total = Readonly<{ currency: string; coefficient: string; scale: number; count: number }>;

function addTotal<T extends Total>(totals: readonly T[], currency: string, exact: ExactAmount, make: (total: Total) => T): T[] {
  const index = totals.findIndex((total) => total.currency === currency);
  if (index < 0) return [...totals, make({ currency, ...exact, count: 1 })].sort((left, right) => left.currency.localeCompare(right.currency));
  const prior = totals[index]!;
  const sum = addKeepingScale(prior, exact);
  return totals.map((total, at) => at === index ? make({ ...prior, coefficient: sum.coefficient, scale: sum.scale, count: prior.count + 1 }) : total);
}

/** The canonical summary with every manual purchase added to its total, month, day, and category. */
export function summaryWithManualPurchases(
  summary: SpendingPurchaseReportSummaryDto,
  purchases: readonly ManualSpendingPurchase[],
): SpendingPurchaseReportSummaryDto {
  if (purchases.length === 0) return summary;
  let totalsByCurrency = [...summary.totalsByCurrency];
  const months = new Map(summary.monthTotals.map((month) => [month.month, month]));
  const days = new Map(summary.dayTotals.map((day) => [day.date, day]));
  let categories = [...summary.categoryTotalsByMonth];
  for (const purchase of purchases) {
    const exact = exactFromManualAmount(purchase.amount);
    const month = purchase.occurredOn.slice(0, 7);
    const currency = purchase.currency;
    totalsByCurrency = addTotal(totalsByCurrency, currency, exact, (total) => total);
    const day = days.get(purchase.occurredOn);
    days.set(purchase.occurredOn, {
      month,
      date: purchase.occurredOn,
      recordCount: (day?.recordCount ?? 0) + 1,
      totalsByCurrency: addTotal(day?.totalsByCurrency ?? [], currency, exact, (total) => total),
    });
    const monthTotal = months.get(month);
    months.set(month, {
      month,
      recordCount: (monthTotal?.recordCount ?? 0) + 1,
      activeDayCount: 0,
      pendingCandidateCount: monthTotal?.pendingCandidateCount ?? null,
      totalsByCurrency: addTotal(monthTotal?.totalsByCurrency ?? [], currency, exact, (total) => total),
    });
    const code = purchase.personalCategory;
    const index = categories.findIndex((entry) => entry.month === month && entry.currency === currency && entry.categoryCode === code);
    if (index < 0) categories.push({ month, currency, categoryCode: code, ...exact, count: 1 });
    else {
      const prior = categories[index]!;
      const sum = addKeepingScale(prior, exact);
      categories = categories.map((entry, at) => at === index ? { ...prior, ...sum, count: prior.count + 1 } : entry);
    }
  }
  const dayTotals = [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
  const activeDays = (month: string) => dayTotals.filter((day) => day.month === month).length;
  return Object.freeze({
    ...summary,
    recordCount: summary.recordCount + purchases.length,
    currencies: [...new Set([...summary.currencies, ...purchases.map((purchase) => purchase.currency)])].sort(),
    totalsByCurrency,
    monthTotals: [...months.values()]
      .map((month) => ({ ...month, activeDayCount: activeDays(month.month) }))
      .sort((left, right) => left.month.localeCompare(right.month)),
    dayTotals,
    categoryTotalsByMonth: categories,
  });
}

/** The Spending page with manual purchases counted in its summary and listed beside it. */
export function spendingPageWithManual(page: SpendingPageDto, manual: ManualSpendingDto): SpendingPageDto {
  const summary = page.purchaseReport.summary;
  if (!summary) return { ...page, manual };
  const merged = summaryWithManualPurchases(summary, manual.purchases);
  const money = merged.totalsByCurrency.map((total) => ({
    currency: total.currency,
    value: exactToNumber(total),
    exact: { coefficient: total.coefficient, scale: total.scale },
  }));
  return Object.freeze({
    ...page,
    canonical: Object.freeze({
      ...page.canonical,
      availability: merged.recordCount > 0 ? "available" as const : page.canonical.availability,
      totalsByCurrency: money,
    }),
    purchaseReport: Object.freeze({ ...page.purchaseReport, totalsByCurrency: merged.totalsByCurrency, summary: merged }),
    manual,
  });
}
